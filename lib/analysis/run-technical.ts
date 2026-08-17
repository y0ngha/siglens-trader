import { runAnalysis } from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    PER_SYMBOL_MAX_MS,
    toErrStr,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';
import { DEFAULT_ANALYSIS_TIMEFRAME } from './timeframe.js';

export async function runTechnicalAnalysis(
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
        // 미지정 시 분석 타임프레임 계약의 기본값(1Hour)으로. '1Day'는 계약 밖이라 금지.
        const timeframe = options.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
        // `force = true` — core의 Redis 분석 캐시를 우회한다.
        //
        // 캐시 키에는 입력 해시가 없고(심볼·타임프레임·모델·프롬프트버전·스킬지문·reasoning)
        // 1Hour TTL이 케이던스 창과 **같은 1시간**이라, 창마다 부르면 한 번 걸러 한 번씩
        // 캐시 히트가 난다. 히트한 결과의 `analyzedAt`은 원본(최대 1시간 전)인데 크론은
        // 저장 시각으로 케이던스 창을 소비하므로, 실제 신규 분석은 **2시간에 한 번**이
        // 된다. execute는 `source_analyzed_at`으로 나이를 재므로 1Hour 한도(2시간)를
        // 넘겨 `stale_analysis`가 되고, 그러면 그 종목의 **청산 평가가 통째로 멈춘다**.
        // 호출 빈도는 이미 케이던스 창이 제한하므로 캐시가 더 줄일 것이 없다.
        const outcome = await runAnalysis(
            options.symbol,
            options.companyName,
            timeframe,
            true,
            undefined,
            {
                modelId: options.modelId,
                userApiKey: options.userApiKey,
                marketDataProvider: getMarketDataProvider(),
                // pro tier로 제출: free 디폴트면 1Hour가 게이팅되고 액션가격이 필터된다.
                tierContext: { userId: null, tier: ANALYSIS_TIER },
                // 상세 분석 항상 ON(스위치 없음). 지정 시 그 값을 따른다.
                reasoning: options.reasoning ?? DEFAULT_ANALYSIS_REASONING,
                signal,
            },
        );

        if (outcome.status === 'cached') return { status: 'cached', result: outcome.result };
        if (outcome.status === 'done') return { status: 'done', result: outcome.result };
        if (outcome.status === 'miss_no_trigger') return { status: 'skipped' };
        // 'error' (tier gate, usage limit) and 'key_error' (BYOK required) both carry an error field.
        if ('error' in outcome) {
            return { status: 'error', error: toErrStr(outcome.error) };
        }
        // S6: 도달 불가 분기. core union이 확장될 경우 tsc가 여기서 컴파일 에러를 낸다.
        const unexpected: never = outcome;
        console.warn('[run-technical] unhandled core status', unexpected);
        return { status: 'skipped' };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
