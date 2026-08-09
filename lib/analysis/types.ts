import type { ModelId, Tier, Timeframe, NewsCardAnalysis } from '@y0ngha/siglens-core';

export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental';

/**
 * 심볼 단위 LLM 타임아웃 상한 (ms).
 *
 * 구 poll-until-done.ts의 MAX_POLL_TIME_MS (150_000) 복원.
 * 직렬 최대 5심볼 × 150s = 750s < lock TTL 780s / maxDuration 800s
 * 각 runner는 남은 deadlineMs와 이 값 중 작은 쪽을 AbortSignal로 전달한다.
 */
export const PER_SYMBOL_MAX_MS = 150_000;

/**
 * Convert any core error value to a plain human-readable string.
 *
 * Priority order:
 * 1. plain string → returned as-is
 * 2. Error instance → `.message`
 * 3. object with `.message: string` (core structured errors: AnalysisLimitError,
 *    TierTimeframeAccessError, etc.) → `.message`
 * 4. anything else → JSON.stringify, falling back to String() for
 *    non-serialisable values (undefined, Symbol, functions).
 *
 * `JSON.stringify` returns `undefined` for those edge cases — `?? String(e)`
 * makes the return type reliably `string` rather than `string | undefined`.
 */
export function toErrStr(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
        return (e as { message: string }).message;
    }
    return JSON.stringify(e) ?? String(e);
}

/**
 * Tier used for every analysis submit/poll against siglens-core.
 *
 * siglens-core gates timeframes (free = 1Day only) and strips action-price
 * fields (entry/stoploss/target/confidence) from analysis results for the
 * free tier via `filterAnalysisResult`. siglens-trader is a private, single-user
 * trading tool that needs the full-fidelity signal set at intraday timeframes
 * (15Min/30Min/1Hour), so it always identifies as `pro` — the tier gates are a
 * product-monetization concern for the public siglens.io site, not for this
 * cron. When no tier context is supplied, core defaults to `free`, which would
 * both block the 1Hour timeframe and gut the trading signals.
 */
export const ANALYSIS_TIER: Tier = 'pro';

/**
 * 상세 분석(reasoning) 기본값. siglens-trader는 "상세 분석 항상 ON" 정책이므로 `true`.
 * 기본값을 한 곳에 모아, 정책이 바뀌면 이 상수만 고치면 되도록 한다(runner·cron 공통 참조).
 */
export const DEFAULT_ANALYSIS_REASONING = true;

// Port: db 의존을 analysis 레이어 밖으로 분리한다. 구현체는 api/cron 레이어가 주입.
export interface NewsCardStore {
    getCards(newsIds: string[]): Promise<Map<string, NewsCardAnalysis>>;
    upsertCards(
        rows: ReadonlyArray<{
            newsId: string;
            symbol: string;
            card: NewsCardAnalysis;
            modelId: string;
        }>,
    ): Promise<void>;
}

export interface RunAnalysisOptions {
    symbol: string;
    companyName: string;
    modelId: ModelId;
    userApiKey?: string;
    timeframe?: Timeframe;
    /** news enrich에 필요. factory가 항상 주입. */
    cardStore?: NewsCardStore;
    /**
     * 상세 분석(deep-thinking reasoning) 토글. 지정하지 않으면 항상 ON으로 취급한다.
     * siglens-trader에는 상세분석 스위치 UI가 없으므로 cron이 항상 `true`로 주입하며,
     * 향후 대시보드에 스위치가 추가되면 이 필드로 값을 흘려보내면 된다(기본값 ON).
     */
    reasoning?: boolean;
    /**
     * 새 LLM 작업을 시작하지 않을 절대 시각(epoch ms). cron 시작 + 690s.
     * 이 시각 이후엔 news enrich/aggregate submit을 시작하지 않고 캐시/완료분만 반환.
     */
    deadlineMs?: number;
}

export interface AnalysisRunResult {
    status: 'done' | 'cached' | 'error' | 'skipped';
    result?: unknown;
    error?: string;
}
