import { submitOverallAnalysis, pollOverallAnalysis } from '@y0ngha/siglens-core';
import type { EnrichedNewsItem, EarningsCalendarItem } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
import { FmpNewsClient } from '../data/fmp-news.js';
import { fetchOptionsSnapshot } from '../data/yahoo-options.js';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import { pollUntilDone } from './poll-until-done.js';
import type { AnalysisRunResult, RunAnalysisOptions } from './types.js';

const fundamentalClient = new FmpFundamentalClient();
const newsClient = new FmpNewsClient();

/**
 * Run overall (4-axis) analysis for the given symbol.
 *
 * Fetches news + options data in parallel, builds the dependency inputs,
 * and submits to siglens-core's overall analysis pipeline. If sub-axis
 * dependencies are not yet cached (`pending_dependencies`), returns
 * `status:'skipped'` — the axis crons populate those caches independently,
 * and the next execute-cron invocation will retry.
 *
 * NOTE: Like `runNewsAnalysis`, raw news items are cast to `EnrichedNewsItem[]`
 * because per-card enrichment is not performed in this automated context.
 */
export async function runOverallAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    try {
        const [news, snapshot] = await Promise.all([
            newsClient.fetchNews(options.symbol, '7d'),
            fetchOptionsSnapshot(options.symbol),
        ]);

        const earningsReports = await fundamentalClient.getEarningsReports(options.symbol);
        const upcomingCalendar: EarningsCalendarItem[] = earningsReports.map((r) => ({
            symbol: r.symbol,
            earningsDate: r.earningsDate,
            epsActual: r.epsActual,
            epsEstimated: r.epsEstimated,
            revenueActual: r.revenueActual,
            revenueEstimated: r.revenueEstimated,
            lastUpdated: r.lastUpdated ?? new Date().toISOString(),
        }));

        const submission = await submitOverallAnalysis({
            symbol: options.symbol,
            companyName: options.companyName,
            timeframe: '1Day',
            modelId: options.modelId,
            newsItems: news as unknown as ReadonlyArray<EnrichedNewsItem>,
            upcomingCalendar,
            fundamentalProvider: fundamentalClient,
            optionsSnapshot: snapshot ?? undefined,
            userApiKey: options.userApiKey,
            technical: {},
            marketDataProvider: getMarketDataProvider(),
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status === 'pending_dependencies' && submission.pendingJobs) {
            // Sub-axis dependencies (technical/news/options/fundamental) are not yet cached.
            // We return 'skipped' here — no retry loop is attempted in this invocation.
            // The individual axis crons run in parallel; once they complete and cache their
            // results, the next execute cron will find them cached and submit successfully.
            return { status: 'skipped', error: 'Dependencies still pending' };
        }
        if (submission.status !== 'submitted' || !('jobId' in submission)) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollOverallAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
