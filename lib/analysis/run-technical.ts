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
import { mapRowsToPriorAnalyses } from './prior-analysis.js';

/** 전략이 일봉 규칙이라 기술 분석도 일봉이 기본이다(리뷰 크론은 명시적으로 넘긴다). */
const DEFAULT_TECHNICAL_TIMEFRAME: Timeframe = '1Day';

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
        // 미지정 시 일봉 — 전략이 일봉 규칙이다(리뷰 크론은 명시적으로 넘긴다).
        const timeframe = options.timeframe ?? DEFAULT_TECHNICAL_TIMEFRAME;
        const priorAnalyses = await fetchPriorAnalyses(options, timeframe);
        // `force = true` — core의 Redis 분석 캐시를 우회한다. 리뷰는 신호가 난 그 순간의 판단을
        // 남기는 것이라(docs/specs/2026-09-24-daily-mean-reversion-design.md §5), 캐시된 분석을 받으면
        // 리뷰 근거가 신호보다 최대 TTL만큼 앞선다. 호출은 신호가 난 종목에만 하루 한 번이라
        // 캐시가 줄여 줄 비용도 없다.
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
