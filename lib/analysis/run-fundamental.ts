import { runFundamentalAnalysis as coreRunFundamentalAnalysis } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

const fundamentalClient = new FmpFundamentalClient();

/** Convert any core error value to a plain string for AnalysisRunResult.error. */
const toErrStr = (e: unknown): string => (typeof e === 'string' ? e : JSON.stringify(e));

export async function runFundamentalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    try {
        const outcome = await coreRunFundamentalAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            dataProvider: fundamentalClient,
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
        });

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // 'error' (usage_limit, fetch_failed) and 'key_error' (BYOK required) both carry an error field.
        if ('error' in outcome) {
            return { status: 'error', error: toErrStr((outcome as { error: unknown }).error) };
        }
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
