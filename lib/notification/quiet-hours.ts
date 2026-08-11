/**
 * Quiet-hours policy for the notification dispatcher.
 *
 * The operator is based in Seoul. The US regular trading session (roughly
 * 22:30–05:00 KST during EDT, or 23:30–06:00 KST during EST) runs through
 * the operator's overnight hours. Rather than firing alerts at 3 AM, fills
 * and errors generated while the operator is asleep are collected and
 * delivered as a single morning digest at 10:00 KST.
 *
 * The window is expressed in the operator's local time (Asia/Seoul), NOT in
 * UTC, because what matters is whether the operator is asleep — not the UTC
 * offset. Seoul does not observe DST so the offset is always UTC+9, but we
 * use Intl.DateTimeFormat for correctness and future-proofing.
 */

/** First Seoul wall-clock hour that is considered quiet (inclusive). */
export const QUIET_HOURS_START = 0; // 00:00 KST (midnight)

/** Last Seoul wall-clock hour that is considered quiet (inclusive, 09:59:59 KST). */
export const QUIET_HOURS_END = 9; // up to 09:59 KST

/**
 * Extract the Seoul wall-clock hour from a UTC instant using Intl.DateTimeFormat.
 * Returns an integer 0–23. Some engines return "24" for midnight with hour12:false;
 * we normalise that to 0.
 */
function seoulHour(now: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        hour: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const h = Number(hourStr);
    return h === 24 ? 0 : h;
}

/**
 * Returns true when the Asia/Seoul wall-clock hour falls in the quiet window
 * [QUIET_HOURS_START, QUIET_HOURS_END] — i.e., hours 0 through 9 inclusive
 * (00:00–09:59 KST). Everything in that window is deferred to the 10:00 KST digest.
 */
export function isQuietHours(now: Date): boolean {
    const h = seoulHour(now);
    return h >= QUIET_HOURS_START && h <= QUIET_HOURS_END;
}
