import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    getEnabledWatchlist,
    getAnalysisConfig,
    getConfigValue,
    saveAnalysisResult,
    startCronRun,
    finishCronRun,
} from '../../lib/db/queries.js';
import type { CronRunFinish, CronType } from '../../lib/db/queries.js';
import type { AnalysisRunResult, RunAnalysisOptions } from '../../lib/analysis/types.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';

type AnalysisRunner = (options: RunAnalysisOptions) => Promise<AnalysisRunResult>;

export function createAnalysisCronHandler(analysisType: string, runner: AnalysisRunner) {
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

        await safe(startCronRun(db, { runId: cronRunId, cronType, startedAt }));

        let finishState: CronRunFinish | null = null;

        try {
            // Skip LLM/API work outside the U.S. regular session (cron schedule is a static approximation)
            if (!isEtRegularSessionOpen(new Date())) {
                finishState = {
                    status: 'skipped',
                    outcome: 'market_closed',
                    durationMs: Date.now() - startedMs,
                    finishedAt: new Date(),
                };
                return Response.json({ skipped: true, reason: 'market_closed' });
            }

            const LOCK_KEY = `cron:${analysisType}:lock`;
            let lockAcquired = false;
            const locked = await acquireLock(LOCK_KEY);
            if (!locked) {
                finishState = {
                    status: 'skipped',
                    outcome: 'locked',
                    durationMs: Date.now() - startedMs,
                    finishedAt: new Date(),
                };
                return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
            }
            lockAcquired = true;

            try {
                const config = await getAnalysisConfig(db, analysisType);
                if (!config?.enabled) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'disabled',
                        durationMs: Date.now() - startedMs,
                        finishedAt: new Date(),
                    };
                    return Response.json({ skipped: true, reason: 'disabled' });
                }

                const watchlistItems = await getEnabledWatchlist(db);
                if (watchlistItems.length === 0) {
                    finishState = {
                        status: 'skipped',
                        outcome: 'empty_watchlist',
                        durationMs: Date.now() - startedMs,
                        finishedAt: new Date(),
                    };
                    return Response.json({ skipped: true, reason: 'empty_watchlist' });
                }

                const results: Array<{ symbol: string; status: string; error?: string }> = [];

                const timeframe = await getConfigValue<string>(db, 'analysis_timeframe');

                // TODO: Consider Promise.allSettled for parallel processing (risk: DB write conflicts)
                for (const item of watchlistItems) {
                    const result = await runner({
                        symbol: item.symbol,
                        companyName: item.companyName,
                        modelId: config.modelId as RunAnalysisOptions['modelId'],
                        userApiKey: config.useByok ? resolveApiKey(config.modelId) : undefined,
                        timeframe: (timeframe as RunAnalysisOptions['timeframe']) ?? undefined,
                    });

                    if (result.status === 'done' || result.status === 'cached') {
                        await saveAnalysisResult(db, {
                            symbol: item.symbol,
                            analysisType,
                            result: result.result,
                            modelId: config.modelId,
                            analyzedAt: new Date(),
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
                    summary: { analyzed: results.length },
                    durationMs: Date.now() - startedMs,
                    finishedAt: new Date(),
                };
                return Response.json({ cronRunId, results });
            } finally {
                if (lockAcquired) await releaseLock(LOCK_KEY);
            }
        } catch (e) {
            finishState = {
                status: 'error',
                error: e instanceof Error ? e.message : String(e),
                durationMs: Date.now() - startedMs,
                finishedAt: new Date(),
            };
            throw e;
        } finally {
            if (finishState) {
                await safe(finishCronRun(db, cronRunId, finishState));
            }
        }
    };
}

export function resolveApiKey(modelId: string): string | undefined {
    if (modelId.startsWith('claude')) return process.env.ANTHROPIC_API_KEY;
    if (modelId.startsWith('gpt')) return process.env.OPENAI_API_KEY;
    if (modelId.startsWith('gemini')) return process.env.GEMINI_API_KEY;
    return undefined;
}
