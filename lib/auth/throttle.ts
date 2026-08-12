/**
 * Failed-login throttle.
 *
 * Once Cloudflare Access is removed the login endpoint is reachable by anyone,
 * so password guessing has to cost something. Counters are per-client-key and
 * only failures count — a successful login clears the bucket.
 *
 * Deliberate ceiling: an in-process Map, which is exactly right for the single-instance
 * deployment (one EC2 box behind one tunnel). Move the counter to Redis if a
 * second app instance is ever added, otherwise the limit multiplies by N.
 */

/** Failures tolerated inside one window before the client is locked out. */
export const MAX_FAILED_ATTEMPTS = 10;

/** Sliding window / lockout duration in milliseconds (15 minutes). */
export const THROTTLE_WINDOW_MS = 15 * 60_000;

interface Bucket {
    failures: number;
    /** Epoch ms at which this bucket stops counting and resets. */
    resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Identify the client for throttling: Cloudflare's real-client header, else the socket peer. */
export function clientKey(req: Request): string {
    return (
        req.headers.get('cf-connecting-ip') ??
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        'unknown'
    );
}

function activeBucket(key: string, now: number): Bucket | null {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (bucket.resetAt <= now) {
        buckets.delete(key);
        return null;
    }
    return bucket;
}

/** True when the client has spent its attempts and must wait for the window to lapse. */
export function isThrottled(key: string, now = Date.now()): boolean {
    return (activeBucket(key, now)?.failures ?? 0) >= MAX_FAILED_ATTEMPTS;
}

/** Seconds until the client's window lapses; 0 when it is not throttled. */
export function retryAfterSeconds(key: string, now = Date.now()): number {
    const bucket = activeBucket(key, now);
    if (!bucket) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

/** Record a failed attempt. The window starts at the first failure and does not extend. */
export function recordFailure(key: string, now = Date.now()): void {
    const bucket = activeBucket(key, now);
    if (bucket) {
        bucket.failures += 1;
        return;
    }
    // Lapsed buckets are otherwise only dropped when their own key is looked up again,
    // so a rotating source of keys would grow the map without bound.
    sweepLapsed(now);
    buckets.set(key, { failures: 1, resetAt: now + THROTTLE_WINDOW_MS });
}

function sweepLapsed(now: number): void {
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

/** Clear the client's failures after a successful login. */
export function clearFailures(key: string): void {
    buckets.delete(key);
}

/** Test seam — drops every bucket. */
export function resetThrottle(): void {
    buckets.clear();
}
