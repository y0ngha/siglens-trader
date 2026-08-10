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
 * Fraction of the nominal interval the guard actually enforces.
 *
 * An analysis is stamped when it is *saved*, which is always later than the tick that
 * started it — the LLM call takes tens of seconds. So the gap between one tick and the
 * next same-cadence tick measures slightly *less* than the nominal interval, and enforcing
 * the full interval would reject the very tick the schedule exists to run:
 *
 *   cron fires 15:00:00 → analysis saved 15:00:50
 *   next day 15:00:00   → elapsed 23h59m10s < 24h → skipped
 *
 * That turns a daily analysis into an every-other-day one, and the hourly news analysis
 * into an every-other-hour one. Shaving 10% off absorbs processing latency (and a little
 * scheduler drift) while still collapsing the surplus ticks the tighter schedules produce:
 * a 60-minute policy admits the hourly tick but still rejects one 15 minutes later.
 */
const SCHEDULE_JITTER_TOLERANCE = 0.9;

/**
 * Returns the minimum interval (ms) that must elapse before re-running a given
 * analysis type for the same symbol.
 *
 * For horizon-sensitive types (technical, options) the interval is the configured
 * timeframe bar duration. The returned value is the nominal interval reduced by
 * {@link SCHEDULE_JITTER_TOLERANCE} so a tick on the intended schedule is never rejected
 * by its own processing latency. Unknown types return 0 so they are never skipped.
 */
export function getMinIntervalMs(analysisType: string, timeframe: AnalysisTimeframe): number {
    const policy = ANALYSIS_MIN_INTERVAL[analysisType];
    if (policy === undefined) return 0;
    const nominal = policy === 'timeframe' ? TIMEFRAME_DURATION_MS[timeframe] : policy;
    return Math.round(nominal * SCHEDULE_JITTER_TOLERANCE);
}
