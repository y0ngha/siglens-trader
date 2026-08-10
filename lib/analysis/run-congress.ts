import { runCongressTrend } from '@y0ngha/siglens-core';
import { FmpCongressTradesClient } from '../data/fmp-congress.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    PER_SYMBOL_MAX_MS,
    toErrStr,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';

export async function runCongressAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
    // 심볼 단위 타임아웃: 남은 deadline과 PER_SYMBOL_MAX_MS 중 작은 값.
    // deadlineMs 미지정 시 PER_SYMBOL_MAX_MS(150s)를 기본 상한으로 사용.
    const remaining =
        options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)
            ? Math.max(0, options.deadlineMs - Date.now())
            : PER_SYMBOL_MAX_MS;
    const signal = AbortSignal.timeout(Math.min(remaining, PER_SYMBOL_MAX_MS));

    try {
        const outcome = await runCongressTrend({
            symbol: options.symbol,
            modelId: options.modelId,
            dataProvider: new FmpCongressTradesClient(),
            userApiKey: options.userApiKey,
            tier: ANALYSIS_TIER,
            // siglens-trader는 상세 분석 항상 ON 정책. 지정 시 그 값을 따른다.
            reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
            signal,
        });

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        // no_trades: 해당 심볼 공시 없음 — 정상, LLM 호출 불필요. skipped로 처리.
        if (outcome.status === 'no_trades') return { status: 'skipped' };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // 'error': 데이터 제공자 fetch 실패 (code: 'fetch_failed').
        if (outcome.status === 'error') {
            return { status: 'error', error: toErrStr(outcome.error) };
        }
        // S6: 도달 불가 분기. core union이 확장될 경우 tsc가 여기서 컴파일 에러를 낸다.
        const unexpected: never = outcome;
        console.warn('[run-congress] unhandled core status', unexpected);
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
