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
import { acquireLockDetailed, releaseLock } from '../../lib/lock.js';
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

            // TTL은 **한 실행이 걸릴 수 있는 최대 시간보다 커야 한다.** 짧으면 실행 도중
            // 락이 만료돼 다음 틱이 새로 잡고 같은 심볼을 동시에 분석한다(execute에서 같은
            // 버그를 고쳤다). 심볼을 병렬로 돌리므로 상한은 종목 수와 무관하게 가장 느린
            // 심볼 하나(최악 ~7분) + 저장이다. 30분은 넉넉한 여유.
            const lock = await acquireLockDetailed(LOCK_KEY, 1800);
            const lockToken = lock.token;
            if (!lockToken) {
                // Redis 장애로 전 크론이 조용히 멈추는 것을 막는다 — `skipped`는
                // `assessCronHealth`가 실패로 세지 않아 경보가 0건이 된다.
                finishState =
                    lock.reason === 'unavailable'
                        ? {
                              status: 'error',
                              outcome: 'locked',
                              error: 'lock backend unavailable',
                              ...elapsed(),
                          }
                        : { status: 'skipped', outcome: 'locked', ...elapsed() };
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

                // 실행 전체의 시간 상한. 심볼이 병렬로 시작하므로 이 값은 더 이상 "뒤쪽
                // 심볼을 자르는 컷오프"가 아니라 **심볼당 타임아웃의 천장**이다 — 각 runner는
                // `min(남은 시간, PER_SYMBOL_MAX_MS=150초)`로 AbortSignal을 건다. 실제 상한을
                // 정하는 것은 150초 쪽이고, 1200초는 news 카드 보강처럼 deadline을 직접 예산
                // 으로 쓰는 경로의 상한으로 남는다(가장 짧은 cadence 창 30분 안).
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

                // 심볼은 서로 독립이라 전부 병렬로 돈다. 직렬일 때는 종목 수 × 심볼당
                // 소요시간이 그대로 실행시간이었고, 컷오프(아래)에 걸린 뒤쪽 종목은 다음
                // 틱으로 밀려 갱신 간격이 벌어졌다. 병렬이면 실행시간 ≈ 가장 느린 심볼
                // 하나이므로 컷오프에 걸릴 일이 사실상 없다. DB 쓰기는 심볼별로 다른 행이라
                // 충돌하지 않는다.
                //
                // 실패를 한 곳에서 삼키지 않는다 — 한 심볼의 예외가 나머지 심볼의 결과까지
                // 버리면 안 되므로 심볼 단위로 잡아 error 상태로 기록한다(직렬 때는 예외가
                // 루프를 끊고 cron 전체를 error로 만들었다).
                const settled = await Promise.all(
                    watchlistItems.map(async (item) => {
                        try {
                            // Cadence guard: skip this symbol when its clock window already has an
                            // analysis. This is what makes a faster cron tick safe — technical and
                            // options fire every 15 minutes, and on a longer horizon the surplus
                            // ticks land in a window that is already covered and collapse, so the
                            // schedule can be tighter than the policy without burning provider
                            // quota.
                            if (cadenceWindowMs > 0) {
                                const latest = await getLatestAnalysisResult(
                                    db,
                                    item.symbol,
                                    analysisType,
                                );
                                if (
                                    latest &&
                                    isWithinCadenceWindow(
                                        latest.analyzedAt.getTime(),
                                        startedMs,
                                        cadenceWindowMs,
                                    )
                                ) {
                                    return { symbol: item.symbol, status: 'skipped' as const };
                                }
                            }

                            // 심볼 작업을 실행 마감으로 감싼다.
                            //
                            // 심볼당 `AbortSignal`(150초)은 LLM 호출만 덮고 FMP I/O는
                            // 덮지 않는다 — `fmpGet`의 세마포어 대기에는 타임아웃이
                            // 없어서, 429가 계속되면 한 심볼이 그 상한을 훌쩍 넘긴다.
                            // 그러면 핸들러가 반환하지 않아 락 해제도 감사 행 마감도
                            // 없고, node-cron의 `noOverlap`이 이후 모든 틱을 프로세스
                            // 재시작까지 막는다. 마감은 그 정지를 끊는 백스톱이다.
                            const result = await withDeadline(
                                runner({
                                    symbol: item.symbol,
                                    companyName: item.companyName,
                                    modelId: config.modelId as RunAnalysisOptions['modelId'],
                                    userApiKey: config.useByok
                                        ? resolveApiKey(config.modelId)
                                        : undefined,
                                    timeframe,
                                    cardStore,
                                    deadlineMs: analysisDeadlineMs,
                                    // 분석 타입별 reasoning 정책(짧은 주기 축은 OFF).
                                    // 대시보드에 스위치가 생기면 config에서 흘려보낸다.
                                    reasoning: getAnalysisReasoning(analysisType),
                                }),
                                analysisDeadlineMs - Date.now(),
                            );

                            if (result.status === 'done' || result.status === 'cached') {
                                const savedAt = new Date();
                                await saveAnalysisResult(db, {
                                    symbol: item.symbol,
                                    analysisType,
                                    result: result.result,
                                    modelId: config.modelId,
                                    analyzedAt: savedAt,
                                    sourceAnalyzedAt: extractSourceAnalyzedAt(
                                        result.result,
                                        savedAt,
                                    ),
                                    cronRunId,
                                });
                            }

                            return {
                                symbol: item.symbol,
                                status: result.status,
                                error: result.error,
                            };
                        } catch (e) {
                            console.error('[analysis-cron]', analysisType, item.symbol, e);
                            return {
                                symbol: item.symbol,
                                status: 'error' as const,
                                error: e instanceof Error ? e.message : String(e),
                            };
                        }
                    }),
                );
                results.push(...settled);

                const byStatus = countResultsByStatus(results);
                // 전 심볼이 실패한 실행은 `completed`가 아니다.
                //
                // 심볼 단위 try/catch를 넣으면서(병렬화) 런 전체가 `error`가 되는 경로가
                // 사라졌다 — LLM 키 만료나 프로바이더 429가 지속되면 5심볼 전부 error인데
                // 런은 `completed`로 남고, `assessCronHealth`는 error 행만 실패로 세므로
                // 아무 경보도 나가지 않는다. 부분 실패는 지금처럼 completed로 둔다.
                const allFailed = byStatus.error > 0 && byStatus.done + byStatus.cached === 0;
                if (allFailed) {
                    finishState = {
                        status: 'error',
                        error: `모든 심볼 실패 (${byStatus.error}/${results.length})`,
                        ...elapsed(),
                    };
                    return Response.json({ cronRunId, results });
                }

                finishState = {
                    status: 'completed',
                    outcome: 'completed',
                    summary: {
                        processed: results.length,
                        saved: results.filter((r) => r.status === 'done' || r.status === 'cached')
                            .length,
                        byStatus,
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

/**
 * `promise`가 `ms` 안에 끝나지 않으면 던진다. 인플라이트 작업을 **취소하지는 못한다** —
 * 그건 각 runner의 AbortSignal 몫이고, 이건 실행이 영영 반환하지 않는 것만 막는다.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) {
        // 인자로 받은 promise에 핸들러를 붙이고 버린다. 안 붙이면 나중에 reject될 때
        // 미처리 rejection이 되어 Node 22 기본 설정(`--unhandled-rejections=throw`)에서
        // 프로세스가 죽는다 — 인프로세스 크론이 통째로 멈춘다.
        void promise.catch(() => {});
        return Promise.reject(new Error('run_deadline'));
    }
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('run_deadline')), ms);
        }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
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
