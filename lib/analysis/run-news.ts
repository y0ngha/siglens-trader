import { runNewsAnalysis as coreRunNewsAnalysis } from '@y0ngha/siglens-core';
import type { EarningsCalendarItem } from '@y0ngha/siglens-core';
import { FmpNewsClient } from '../data/fmp-news.js';
import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
import { enrichNewsCards } from './enrich-news-cards.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

const newsClient = new FmpNewsClient();
const fundamentalClient = new FmpFundamentalClient();

/** Convert any core error value to a plain string for AnalysisRunResult.error. */
const toErrStr = (e: unknown): string => (typeof e === 'string' ? e : JSON.stringify(e));

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

        const outcome = await coreRunNewsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            news: enriched,
            upcomingCalendar,
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
        });

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // 'error' (no_news, usage_limit) and 'key_error' (BYOK required) both carry an error field.
        if ('error' in outcome) {
            return { status: 'error', error: toErrStr((outcome as { error: unknown }).error) };
        }
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
