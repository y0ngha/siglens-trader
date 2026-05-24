import { submitAnalysis, pollAnalysis } from '@y0ngha/siglens-core';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

export async function runTechnicalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    try {
        const submission = await submitAnalysis(
            options.symbol,
            options.companyName,
            '1Day',
            false,
            undefined,
            { modelId: options.modelId, userApiKey: options.userApiKey },
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
