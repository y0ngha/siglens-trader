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
import { DEFAULT_ANALYSIS_REASONING } from '../../lib/analysis/types.js';
import { extractSourceAnalyzedAt } from '../../lib/analysis/source-time.js';
import { toCoreTimeframe } from '../../lib/analysis/timeframe.js';
import type { AnalysisTimeframe } from '../../lib/analysis/timeframe.js';
import { getMinIntervalMs } from '../../lib/analysis/cadence.js';
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
            const lockToken = await acquireLock(LOCK_KEY, 780);
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

                // 새 LLM 작업 컷오프: cron 시작 + 690s. maxDuration(800s) 안에서 한 심볼이
                // 전체 cron의 audit 마감을 막지 못하도록 runner에 deadline을 전달한다.
                const analysisDeadlineMs = startedMs + 690_000;

                // Port 구현체: analysis 레이어가 db 직접 의존하지 않도록 cron 레이어에서 주입.
                const cardStore: NewsCardStore = {
                    getCards: (ids) => getNewsCards(db, ids),
                    upsertCards: (rows) => upsertNewsCards(db, [...rows]),
                };

                // Cadence guard: the minimum re-analysis interval for this type.
                // toCoreTimeframe always returns one of the three AnalysisTimeframe literals;
                // the wider Timeframe type is a TS artifact of the return annotation.
                const minIntervalMs = getMinIntervalMs(
                    analysisType,
                    timeframe as AnalysisTimeframe,
                );

                // TODO: Consider Promise.allSettled for parallel processing (risk: DB write conflicts)
                for (const item of watchlistItems) {
                    // Freshness guard: skip this symbol if the last stored analysis for
                    // (symbol, analysisType) is still within the cadence window.
                    // This is what makes a faster cron tick safe: technical and options
                    // fire every 15 minutes, but if the configured horizon is 1Hour the
                    // guard collapses the extra ticks so only one LLM call runs per hour
                    // per symbol — the schedule can be set tighter than the policy without
                    // burning provider quota.
                    if (minIntervalMs > 0) {
                        const latest = await getLatestAnalysisResult(db, item.symbol, analysisType);
                        if (latest && startedMs - latest.analyzedAt.getTime() < minIntervalMs) {
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
                        // 상세 분석 항상 ON. 대시보드에 스위치가 생기면 이 값을 config에서 흘려보낸다.
                        reasoning: DEFAULT_ANALYSIS_REASONING,
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
