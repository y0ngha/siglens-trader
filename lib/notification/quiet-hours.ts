/**
 * Quiet-hours policy for the notification dispatcher.
 *
 * The operator is based in Seoul. The US regular trading session (roughly
 * 22:30–05:00 KST during EDT, or 23:30–06:00 KST during EST) runs through
 * the operator's overnight hours. Rather than firing alerts at 3 AM, fills
 * and errors generated while the operator is asleep are collected and
 * delivered as a single morning digest at the configured hour (`config.digest_hour_kst`,
 * default 10:00 KST).
 *
 * The window is expressed in the operator's local time (Asia/Seoul), NOT in
 * UTC, because what matters is whether the operator is asleep — not the UTC
 * offset. Seoul does not observe DST so the offset is always UTC+9, but we
 * use Intl.DateTimeFormat for correctness and future-proofing.
 */

/**
 * Default digest hour (Seoul wall clock). The quiet window is 00:00 up to — not including —
 * this hour; the morning digest delivers what was queued at this hour.
 */
export const DEFAULT_DIGEST_HOUR = 10;

/** Allowed range for `config.digest_hour_kst`. 0 would mean "no quiet window" and 24 is not an hour. */
export const DIGEST_HOUR_MIN = 1;
export const DIGEST_HOUR_MAX = 23;

/**
 * `config.digest_hour_kst` → a usable hour. Anything that is not an integer in
 * [DIGEST_HOUR_MIN, DIGEST_HOUR_MAX] (missing row, corrupted value) falls back to the default —
 * the API rejects bad writes, this only guards against rows written by other means.
 */
export function parseDigestHour(value: unknown): number {
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= DIGEST_HOUR_MIN &&
        value <= DIGEST_HOUR_MAX
        ? value
        : DEFAULT_DIGEST_HOUR;
}

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
 * [00:00, digestHour) — with the default, 00:00–09:59 KST. Everything in that window is
 * deferred to the digest, which the digest cron sends at `digestHour`.
 */
export function isQuietHours(now: Date, digestHour: number = DEFAULT_DIGEST_HOUR): boolean {
    return seoulHour(now) < digestHour;
}

const SEOUL_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Seoul calendar date `YYYY-MM-DD`. */
export function seoulDate(now: Date): string {
    return SEOUL_DATE.format(now);
}

/** 00:00 Asia/Seoul of `now`'s Seoul day, as an instant. Seoul has no DST, so +09:00 is exact. */
export function seoulDayStart(now: Date): Date {
    return new Date(`${seoulDate(now)}T00:00:00+09:00`);
}
