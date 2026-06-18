import { submitAnalysis, pollAnalysis } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import { pollUntilDone } from './poll-until-done.js';
import type { AnalysisRunResult, RunAnalysisOptions } from './types.js';
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
            },
        );

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
