import { submitOverallAnalysis, pollOverallAnalysis } from '@y0ngha/siglens-core';
import type { EnrichedNewsItem, EarningsCalendarItem } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '@lib/data/fmp-fundamental';
import { FmpNewsClient } from '@lib/data/fmp-news';
import { fetchOptionsSnapshot } from '@lib/data/yahoo-options';
import { getMarketDataProvider } from '@lib/data/fmp-market-data-provider';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const fundamentalClient = new FmpFundamentalClient();
const newsClient = new FmpNewsClient();

/**
 * Run overall (4-axis) analysis for the given symbol.
 *
 * Fetches news + options data in parallel, builds the dependency inputs,
 * and submits to siglens-core's overall analysis pipeline. Handles
 * `pending_dependencies` by polling the overall job until resolution.
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
            // Overall analysis has pending sub-axes; poll the overall job
            // The caller should retry submitOverallAnalysis after dependencies resolve.
            // For simplicity, we wait and re-submit in a loop.
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
