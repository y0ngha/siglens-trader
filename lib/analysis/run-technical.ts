import { submitAnalysis, pollAnalysis } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import { pollUntilDone } from './poll-until-done.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';
import { DEFAULT_ANALYSIS_TIMEFRAME } from './timeframe.js';

export async function runTechnicalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    try {
        // 미지정 시 분석 타임프레임 계약의 기본값(1Hour)으로. '1Day'는 계약 밖이라 금지.
        const timeframe = options.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
        const submission = await submitAnalysis(
            options.symbol,
            options.companyName,
            timeframe,
            false,
            undefined,
            {
                modelId: options.modelId,
                userApiKey: options.userApiKey,
                marketDataProvider: getMarketDataProvider(),
                // pro tier로 제출: free 디폴트면 1Hour가 게이팅되고 액션가격이 필터된다.
                tierContext: { userId: null, tier: ANALYSIS_TIER },
                // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
                reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
            },
        );

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        // poll 시점에도 caller tier로 재게이팅/필터되므로 submit과 동일한 pro tier를 넘긴다.
        const polled = await pollUntilDone(
            (jobId) => pollAnalysis(jobId, { tier: ANALYSIS_TIER }),
            submission.jobId,
        );
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
