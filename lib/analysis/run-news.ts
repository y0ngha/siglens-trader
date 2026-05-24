import { submitNewsAnalysis, pollNewsAnalysis } from '@y0ngha/siglens-core';
import type { EnrichedNewsItem, EarningsCalendarItem } from '@y0ngha/siglens-core';
import { FmpNewsClient } from '@lib/data/fmp-news';
import { FmpFundamentalClient } from '@lib/data/fmp-fundamental';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const newsClient = new FmpNewsClient();
const fundamentalClient = new FmpFundamentalClient();

/**
 * Run news analysis for the given symbol.
 *
 * Fetches raw news and earnings data, converts to the format expected by
 * siglens-core's `submitNewsAnalysis`, and polls until done.
 *
 * NOTE: `submitNewsAnalysis` expects `EnrichedNewsItem[]` (news items with
 * per-card AI analysis). This runner casts raw `NewsItem[]` to satisfy the
 * type constraint — the core worker handles missing card data gracefully
 * for automated trading contexts where per-card enrichment is not required.
 */
export async function runNewsAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    try {
        const news = await newsClient.fetchNews(options.symbol, '7d');
        if (news.length === 0) return { status: 'skipped' };

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

        const submission = await submitNewsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            news: news as unknown as EnrichedNewsItem[],
            upcomingCalendar,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !('jobId' in submission)) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollNewsAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
