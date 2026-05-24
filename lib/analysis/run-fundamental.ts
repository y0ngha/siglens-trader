import { submitFundamentalAnalysis, pollFundamentalAnalysis } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '@lib/data/fmp-fundamental';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const fundamentalClient = new FmpFundamentalClient();

export async function runFundamentalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    try {
        const submission = await submitFundamentalAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            dataProvider: fundamentalClient,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !('jobId' in submission)) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollFundamentalAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
