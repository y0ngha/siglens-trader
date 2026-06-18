import { submitNewsAnalysis, pollNewsAnalysis } from '@y0ngha/siglens-core';
import type { EarningsCalendarItem } from '@y0ngha/siglens-core';
import { FmpNewsClient } from '../data/fmp-news.js';
import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
import { pollUntilDone } from './poll-until-done.js';
import { enrichNewsCards } from './enrich-news-cards.js';
import type { AnalysisRunResult, RunAnalysisOptions } from './types.js';

const newsClient = new FmpNewsClient();
const fundamentalClient = new FmpFundamentalClient();

export async function runNewsAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    if (!options.cardStore) {
        return { status: 'error', error: 'cardStore not provided to runNewsAnalysis' };
    }
    const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    try {
        const news = await newsClient.fetchNews(options.symbol, '7d');
        if (news.length === 0) return { status: 'skipped' };

        const enriched = await enrichNewsCards(options.cardStore, options.symbol, news, {
            deadlineMs,
        });
        // enrich가 비었거나 새 LLM 작업을 시작할 시간이 없으면 aggregate 단계를 건너뛴다.
        // 한 심볼이 전체 cron의 audit 마감을 막지 못하도록.
        if (enriched.length === 0 || Date.now() >= deadlineMs) return { status: 'skipped' };

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
            news: enriched,
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
