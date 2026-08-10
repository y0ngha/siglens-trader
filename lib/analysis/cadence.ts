import type { AnalysisTimeframe } from './timeframe.js';

/**
 * Per-analysis-type cadence policy.
 *
 * A signal is only worth re-computing as often as its underlying data can change.
 * Re-running it faster than that burns LLM calls and provider quota without
 * improving the decision.
 *
 * - technical / options: horizon-sensitive — a new bar only closes once per
 *   timeframe tick, so re-analysis earlier than that produces the same signal
 *   from stale inputs. Cadence = bar duration.
 * - news: event-driven — major catalysts surface within ~60 min of publication,
 *   and FMP's news endpoint is heavily rate-limited, so hourly is the right cadence.
 * - fundamental / congress: the underlying data moves quarterly / weekly.
 *   Daily re-analysis is more than enough; more frequent runs burn LLM calls on
 *   data that hasn't changed since the last cron.
 */

/** Duration in ms per timeframe bar — used by horizon-sensitive analysis types. */
const TIMEFRAME_DURATION_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 15 * 60_000,
    '30Min': 30 * 60_000,
    '1Hour': 60 * 60_000,
};

/**
 * Describes the minimum spacing between two analyses of the same type for the
 * same symbol. Horizon-sensitive types use `'timeframe'` as a sentinel — the
 * actual interval is resolved to the configured bar duration at call time.
 */
export const ANALYSIS_MIN_INTERVAL: Readonly<Record<string, number | 'timeframe'>> = {
    technical: 'timeframe',
    options: 'timeframe',
    news: 60 * 60_000, // 60 minutes
    fundamental: 24 * 60 * 60_000, // 24 hours
    congress: 24 * 60 * 60_000, // 24 hours
};

/**
 * Returns the cadence window (ms) for an analysis type, or 0 when the type has no policy
 * (in which case it is never skipped).
 *
 * For horizon-sensitive types (technical, options) the window is the configured timeframe
 * bar duration.
 */
export function getCadenceWindowMs(analysisType: string, timeframe: AnalysisTimeframe): number {
    const policy = ANALYSIS_MIN_INTERVAL[analysisType];
    if (policy === undefined) return 0;
    return policy === 'timeframe' ? TIMEFRAME_DURATION_MS[timeframe] : policy;
}

/**
 * Whether an analysis is already covered for the wall-clock window `now` falls in.
 *
 * Windows are fixed slices of the clock (a 30-minute policy gives :00–:29 and :30–:59), and
 * a window is satisfied once any analysis has been stamped inside it. That is deliberately
 * NOT "enough time has passed since the last run", which is what this guard used to do and
 * which drifts:
 *
 *   an analysis is stamped when it is *saved*, i.e. after the LLM call. Measuring elapsed
 *   time from that stamp means the gap to the next scheduled tick is short by exactly the
 *   processing time, so that tick gets rejected and the work slides to the one after it.
 *   With a 30-minute policy and a 5-minute analysis, the tick at :30 sees only 25 minutes
 *   elapsed and skips — the real cadence silently becomes 45 minutes. Percentage tolerances
 *   only move where that cliff sits; they do not remove it, because the latency is a
 *   property of the model, not a constant.
 *
 * Comparing window indices instead makes the guard immune to latency: each clock window
 * admits exactly one run, no matter how long that run takes, while the surplus ticks from a
 * tighter schedule still collapse (on a 30-minute window the extra 15-minute tick lands in
 * the same window and is skipped).
 */
export function isWithinCadenceWindow(
    lastAnalyzedAtMs: number,
    nowMs: number,
    windowMs: number,
): boolean {
    if (windowMs <= 0) return false;
    return Math.floor(lastAnalyzedAtMs / windowMs) === Math.floor(nowMs / windowMs);
}
