import { submitOptionsAnalysis, pollOptionsAnalysis } from '@y0ngha/siglens-core';
import { fetchOptionsSnapshot } from '@lib/data/yahoo-options';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

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
