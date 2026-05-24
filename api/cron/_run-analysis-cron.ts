import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import { getEnabledWatchlist, getAnalysisConfig, saveAnalysisResult } from '../../lib/db/queries';
import type { AnalysisRunResult, RunAnalysisOptions } from '../../lib/analysis/types';

type AnalysisRunner = (options: RunAnalysisOptions) => Promise<AnalysisRunResult>;

export function createAnalysisCronHandler(analysisType: string, runner: AnalysisRunner) {
    return async function handler(req: Request): Promise<Response> {
        if (!verifyCronSecret(req)) {
            return new Response('Unauthorized', { status: 401 });
        }

        const db = getDb();
        const config = await getAnalysisConfig(db, analysisType);
        if (!config?.enabled) {
            return Response.json({ skipped: true, reason: 'disabled' });
        }

        const watchlistItems = await getEnabledWatchlist(db);
        if (watchlistItems.length === 0) {
            return Response.json({ skipped: true, reason: 'empty_watchlist' });
        }

        const cronRunId = `${analysisType}-${Date.now()}`;
        const results: Array<{ symbol: string; status: string; error?: string }> = [];

        for (const item of watchlistItems) {
            const result = await runner({
                symbol: item.symbol,
                companyName: item.companyName,
                modelId: config.modelId as RunAnalysisOptions['modelId'],
                userApiKey: config.useByok ? resolveApiKey(config.modelId) : undefined,
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

            results.push({ symbol: item.symbol, status: result.status, error: result.error });
        }

        return Response.json({ cronRunId, results });
    };
}

export function resolveApiKey(modelId: string): string | undefined {
    if (modelId.startsWith('claude')) return process.env.ANTHROPIC_API_KEY;
    if (modelId.startsWith('gpt')) return process.env.OPENAI_API_KEY;
    if (modelId.startsWith('gemini')) return process.env.GEMINI_API_KEY;
    return undefined;
}
