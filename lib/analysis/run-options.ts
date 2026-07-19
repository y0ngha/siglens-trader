import { submitOptionsAnalysis, pollOptionsAnalysis } from '@y0ngha/siglens-core';
import { fetchOptionsSnapshot } from '../data/yahoo-options.js';
import { pollUntilDone } from './poll-until-done.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

export async function runOptionsAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    try {
        const snapshot = await fetchOptionsSnapshot(options.symbol);
        if (!snapshot || snapshot.chains.length === 0) return { status: 'skipped' };

        const expirationDate = snapshot.chains[0].expirationDate;

        const submission = await submitOptionsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            snapshot,
            expirationDate,
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !('jobId' in submission)) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollOptionsAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
