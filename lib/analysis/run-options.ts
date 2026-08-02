import { runOptionsAnalysis as coreRunOptionsAnalysis } from '@y0ngha/siglens-core';
import { fetchOptionsSnapshot } from '../data/yahoo-options.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

/** Convert any core error value to a plain string for AnalysisRunResult.error. */
const toErrStr = (e: unknown): string => (typeof e === 'string' ? e : JSON.stringify(e));

export async function runOptionsAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    try {
        const snapshot = await fetchOptionsSnapshot(options.symbol);
        if (!snapshot || snapshot.chains.length === 0) return { status: 'skipped' };

        const expirationDate = snapshot.chains[0].expirationDate;

        const outcome = await coreRunOptionsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            snapshot,
            expirationDate,
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
        });

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // sanitizeOptionsChain found no usable chains — same as pre-call empty-chains check.
        if (outcome.status === 'no_chains_error') return { status: 'skipped' };
        // 'limit_error' (usage quota) and 'key_error' (BYOK required) both carry an error field.
        if ('error' in outcome) {
            return { status: 'error', error: toErrStr((outcome as { error: unknown }).error) };
        }
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
