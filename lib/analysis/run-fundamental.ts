import { runFundamentalAnalysis as coreRunFundamentalAnalysis } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    PER_SYMBOL_MAX_MS,
    toErrStr,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

const fundamentalClient = new FmpFundamentalClient();

export async function runFundamentalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    // 심볼 단위 타임아웃: 남은 deadline과 PER_SYMBOL_MAX_MS 중 작은 값.
    // deadlineMs 미지정 시 PER_SYMBOL_MAX_MS(150s)를 기본 상한으로 사용.
    const remaining =
        options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)
            ? Math.max(0, options.deadlineMs - Date.now())
            : PER_SYMBOL_MAX_MS;
    const signal = AbortSignal.timeout(Math.min(remaining, PER_SYMBOL_MAX_MS));

    try {
        const outcome = await coreRunFundamentalAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            dataProvider: fundamentalClient,
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
            signal,
        });

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // 'error': usage_limit (error 필드 required) or fetch_failed (error 필드 optional).
        // SubmitFundamentalAnalysisFetchError.error는 optional이므로 'error' in outcome
        // 가드만으로는 FetchError(error 없음) 케이스를 소진할 수 없다 → status로 명시 구분.
        if (outcome.status === 'error') {
            return { status: 'error', error: toErrStr(outcome.error ?? outcome.code) };
        }
        // 'key_error' (BYOK required)
        if (outcome.status === 'key_error') {
            return { status: 'error', error: toErrStr(outcome.error) };
        }
        // S6: 도달 불가 분기. core union이 확장될 경우 tsc가 여기서 컴파일 에러를 낸다.
        const unexpected: never = outcome;
        console.warn('[run-fundamental] unhandled core status', unexpected);
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
