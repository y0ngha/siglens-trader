import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    getEnabledWatchlist,
    getAnalysisConfig,
    getConfigValue,
    getLatestAnalysisResult,
    saveAnalysisResult,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
    getNewsCards,
    upsertNewsCards,
} from '../../lib/db/queries.js';
import type { CronRunFinish, CronType } from '../../lib/db/queries.js';
import type {
    AnalysisRunResult,
    NewsCardStore,
    RunAnalysisOptions,
} from '../../lib/analysis/types.js';
import { getAnalysisReasoning } from '../../lib/analysis/types.js';
import { extractSourceAnalyzedAt } from '../../lib/analysis/source-time.js';
import { toCoreTimeframe } from '../../lib/analysis/timeframe.js';
import type { AnalysisTimeframe } from '../../lib/analysis/timeframe.js';
import { getCadenceWindowMs, isWithinCadenceWindow } from '../../lib/analysis/cadence.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';

type AnalysisRunner = (options: RunAnalysisOptions) => Promise<AnalysisRunResult>;

export function createAnalysisCronHandler(analysisType: string, runner: AnalysisRunner) {
    const LOCK_KEY = `cron:${analysisType}:lock`;

    return async function handler(req: Request): Promise<Response> {
        if (!verifyCronSecret(req)) {
            return new Response('Unauthorized', { status: 401 });
        }

        const startedAt = new Date();
        const startedMs = startedAt.getTime();
        const cronRunId = `${analysisType}-${crypto.randomUUID()}`;
        const db = getDb();
        const cronType = analysisType as CronType;

        // Best-effort audit helper — failures never break the cron
        const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
        const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

        // Finalize any audit rows stuck in 'running' past the stale threshold (a
        // prior invocation that timed out before writing its finish row). Best-effort.
        await safe(finalizeStaleCronRuns(db, startedAt));
        await safe(startCronRun(db, { runId: cronRunId, cronType, startedAt }));

        let finishState: CronRunFinish | null = null;

        try {
            // Skip LLM/API work outside the U.S. regular session (cron schedule is a static approximation)
            if (!isEtRegularSessionOpen(new Date())) {
                finishState = {
                    status: 'skipped',
                    outcome: 'market_closed',
                    ...elapsed(),
                };
                return Response.json({ skipped: true, reason: 'market_closed' });
            }

            // TTL 780s < maxDuration(800s): a hung run holds the lock for its whole life (no mid-run expiry/overlap).
            // TTL은 **한 실행이 걸릴 수 있는 최대 시간보다 커야 한다.** 짧으면 실행 도중
            // 락이 만료돼 다음 틱이 새로 잡고 같은 심볼을 동시에 분석한다(execute에서 같은
            // 버그를 고쳤다). 위 컷오프 1200초 + 진행 중이던 심볼 하나(~7분) = 약 27분이
            // 상한이므로 30분으로 잡는다.
            const lockToken = await acquireLock(LOCK_KEY, 1800);
            if (!lockToken) {
                finishState = {
                    status: 'skipped',
                    outcome: 'locked',
                    ...elapsed(),
                };
                return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
            }

            try {
                const config = await getAnalysisConfig(db, analysisType);
                if (!config?.enabled) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'disabled',
                        ...elapsed(),
                    };
                    return Response.json({ skipped: true, reason: 'disabled' });
                }

                const watchlistItems = await getEnabledWatchlist(db);
                if (watchlistItems.length === 0) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'empty_watchlist',
                        ...elapsed(),
                    };
                    return Response.json({ skipped: true, reason: 'empty_watchlist' });
                }

                const results: Array<{
                    symbol: string;
                    status: AnalysisRunResult['status'];
                    error?: string;
                }> = [];

                const timeframe = toCoreTimeframe(
                    await getConfigValue<string>(db, 'analysis_timeframe'),
                );

                // 새 LLM 작업 컷오프. 이 시각을 넘기면 남은 심볼의 LLM 호출을 시작하지 않는다.
                //
                // 종전 690초는 Vercel `maxDuration`(800초)에서 역산한 값인데, EC2에는 실행
                // 시간 상한이 없으므로 그 근거가 사라졌다. technical에 추론을 켜면 심볼당
                // 수 분이 걸려 690초에서는 두 번째 심볼부터 잘린다 — 잘린 종목은 다음 틱에
                // 재시도되지만, 매 패스마다 로테이션하면 갱신 간격이 필요 이상으로 벌어진다.
                //
                // 1200초로 잡은 근거: 심볼 3개 기준 마지막 심볼이 약 14분에 시작하므로 전부
                // 들어간다. 컷오프 직전에 시작한 심볼 하나(최악 ~7분)를 더해도 실행 상한이
                // 약 27분이라 **cadence 창 30분 안에 머문다** — 마지막 종목의 분석이 다음
                // 창으로 넘어가 그 창을 소비하는 경우를 정상 상황에서는 피한다.
                // 종목이 늘면 컷오프가 뒤쪽 심볼을 다음 틱으로 넘긴다(의도된 degrade).
                const analysisDeadlineMs = startedMs + 1_200_000;

                // Port 구현체: analysis 레이어가 db 직접 의존하지 않도록 cron 레이어에서 주입.
                const cardStore: NewsCardStore = {
                    getCards: (ids) => getNewsCards(db, ids),
                    upsertCards: (rows) => upsertNewsCards(db, [...rows]),
                };

                // Cadence guard: the clock window this type gets one analysis per.
                // toCoreTimeframe always returns one of the three AnalysisTimeframe literals;
                // the wider Timeframe type is a TS artifact of the return annotation.
                const cadenceWindowMs = getCadenceWindowMs(
                    analysisType,
                    timeframe as AnalysisTimeframe,
                );

                // TODO: Consider Promise.allSettled for parallel processing (risk: DB write conflicts)
                for (const item of watchlistItems) {
                    // Cadence guard: skip this symbol when its clock window already has an
                    // analysis. This is what makes a faster cron tick safe — technical and
                    // options fire every 15 minutes, and on a longer horizon the surplus
                    // ticks land in a window that is already covered and collapse, so the
                    // schedule can be tighter than the policy without burning provider quota.
                    if (cadenceWindowMs > 0) {
                        const latest = await getLatestAnalysisResult(db, item.symbol, analysisType);
                        if (
                            latest &&
                            isWithinCadenceWindow(
                                latest.analyzedAt.getTime(),
                                startedMs,
                                cadenceWindowMs,
                            )
                        ) {
                            results.push({ symbol: item.symbol, status: 'skipped' });
                            continue;
                        }
                    }

                    const result = await runner({
                        symbol: item.symbol,
                        companyName: item.companyName,
                        modelId: config.modelId as RunAnalysisOptions['modelId'],
                        userApiKey: config.useByok ? resolveApiKey(config.modelId) : undefined,
                        timeframe,
                        cardStore,
                        deadlineMs: analysisDeadlineMs,
                        // 분석 타입별 reasoning 정책(짧은 주기 축은 OFF). 대시보드에 스위치가
                        // 생기면 이 값을 config에서 흘려보낸다.
                        reasoning: getAnalysisReasoning(analysisType),
                    });

                    if (result.status === 'done' || result.status === 'cached') {
                        const savedAt = new Date();
                        await saveAnalysisResult(db, {
                            symbol: item.symbol,
                            analysisType,
                            result: result.result,
                            modelId: config.modelId,
                            analyzedAt: savedAt,
                            sourceAnalyzedAt: extractSourceAnalyzedAt(result.result, savedAt),
                            cronRunId,
                        });
                    }

                    results.push({
                        symbol: item.symbol,
                        status: result.status,
                        error: result.error,
                    });
                }

                finishState = {
                    status: 'completed',
                    outcome: 'completed',
                    summary: {
                        processed: results.length,
                        saved: results.filter((r) => r.status === 'done' || r.status === 'cached')
                            .length,
                        byStatus: countResultsByStatus(results),
                        results: results.map((r) => ({
                            symbol: r.symbol,
                            status: r.status,
                            ...(r.error ? { error: r.error } : {}),
                        })),
                    },
                    ...elapsed(),
                };
                return Response.json({ cronRunId, results });
            } finally {
                await releaseLock(LOCK_KEY, lockToken).catch((e) =>
                    console.error('[lock-release]', e),
                );
            }
        } catch (e) {
            finishState = {
                status: 'error',
                error: e instanceof Error ? e.message : String(e),
                ...elapsed(),
            };
            throw e;
        } finally {
            if (finishState) {
                await safe(finishCronRun(db, cronRunId, finishState));
            }
        }
    };
}

function countResultsByStatus(results: Array<{ status: AnalysisRunResult['status'] }>) {
    return results.reduce<Record<AnalysisRunResult['status'], number>>(
        (acc, result) => {
            acc[result.status] += 1;
            return acc;
        },
        { done: 0, cached: 0, skipped: 0, error: 0 },
    );
}

/**
 * BYOK 모드에서 modelId에 맞는 서버 API 키를 반환한다.
 *
 * 지원 프리픽스: claude → ANTHROPIC_API_KEY, gpt → OPENAI_API_KEY,
 * gemini → GEMINI_API_KEY, deepseek → DEEPSEEK_API_KEY.
 *
 * 키가 필요한데 환경변수가 비어있으면 경고를 남겨 운영자가 진단할 수 있게 한다.
 * (조용히 undefined를 흘려보내면 매 cron 실행마다 불투명한 BYOK 오류가 발생한다.)
 */
export function resolveApiKey(modelId: string): string | undefined {
    let envKey: string;
    let value: string | undefined;

    if (modelId.startsWith('claude')) {
        envKey = 'ANTHROPIC_API_KEY';
        value = process.env.ANTHROPIC_API_KEY;
    } else if (modelId.startsWith('gpt')) {
        envKey = 'OPENAI_API_KEY';
        value = process.env.OPENAI_API_KEY;
    } else if (modelId.startsWith('gemini')) {
        envKey = 'GEMINI_API_KEY';
        value = process.env.GEMINI_API_KEY;
    } else if (modelId.startsWith('deepseek')) {
        envKey = 'DEEPSEEK_API_KEY';
        value = process.env.DEEPSEEK_API_KEY;
    } else {
        // 알 수 없는 프리픽스 — BYOK 키 없음. core가 key_error를 반환한다.
        return undefined;
    }

    if (!value) {
        console.warn(`[resolveApiKey] ${envKey} is not set — BYOK calls for ${modelId} will fail`);
    }
    return value;
}
