import {
    analysisHistoryQuery,
    runAnalysis,
    type PriorAnalysis,
    type Timeframe,
} from '@y0ngha/siglens-core';
import { getMarketDataProvider } from '../data/fmp-market-data-provider.js';
import {
    ANALYSIS_TIER,
    DEFAULT_ANALYSIS_REASONING,
    symbolSignal,
    toErrStr,
    type AnalysisRunResult,
    type RunAnalysisOptions,
} from './types.js';
import { DEFAULT_ANALYSIS_TIMEFRAME } from './timeframe.js';
import { mapRowsToPriorAnalyses } from './prior-analysis.js';

/**
 * Fetches + maps prior-analysis history for `runAnalysis`'s `priorAnalyses` option.
 *
 * **Never fails the analysis.** This is additional context, not a precondition — omitting
 * `priorAnalyses` leaves the prompt and (for callers that don't force-bypass, unlike this repo)
 * the cache key byte-identical, so any failure here just falls back to that pre-existing
 * behavior. A missing store (other four analysis axes, or a caller that doesn't wire one) is the
 * normal case, not an error.
 *
 * Sizes the query with core's `analysisHistoryQuery(timeframe)` — a deliberately generous
 * coarse pre-filter that core re-cuts twice afterwards (cache-window exclusion, then a
 * bar-anchored window). Never narrow below what it returns; under-fetching silently disables
 * the feature with no error anywhere.
 */
async function fetchPriorAnalyses(
    options: RunAnalysisOptions,
    timeframe: Timeframe,
): Promise<PriorAnalysis[]> {
    if (!options.priorAnalysisStore) return [];
    try {
        const { limit, sinceMs } = analysisHistoryQuery(timeframe);
        const rows = await options.priorAnalysisStore.getRecent({
            symbol: options.symbol,
            timeframe,
            limit,
            since: new Date(Date.now() - sinceMs),
        });
        return mapRowsToPriorAnalyses(rows);
    } catch (err) {
        console.warn('[run-technical] prior-analysis fetch failed, proceeding without it', err);
        return [];
    }
}

export async function runTechnicalAnalysis(
    options: RunAnalysisOptions,
): Promise<AnalysisRunResult> {
    // 심볼 단위 상한은 없다 — 실행 마감까지가 이 호출의 예산이다({@link symbolSignal}).
    const signal = symbolSignal(options.deadlineMs);

    try {
        // 미지정 시 분석 타임프레임 계약의 기본값(1Hour)으로. '1Day'는 계약 밖이라 금지.
        const timeframe = options.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
        const priorAnalyses = await fetchPriorAnalyses(options, timeframe);
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
                // 빈 배열이면 생략한다 — core 문서상 "omitting it leaves the prompt and
                // cache key byte-identical"과 정확히 같은 상태로 두기 위해서다(이 저장소는
                // force=true라 캐시 키는 무관하지만, 프롬프트 바이트는 여전히 동일해야 한다).
                priorAnalyses: priorAnalyses.length > 0 ? priorAnalyses : undefined,
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
