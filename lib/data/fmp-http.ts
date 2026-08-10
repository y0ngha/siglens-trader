import { readFmpConfig } from '@y0ngha/siglens-core';

/** Base URL for all FMP `/stable/*` endpoints. */
export const FMP_STABLE_BASE = 'https://financialmodelingprep.com/stable';

/** Timeout for each individual FMP fetch attempt (ms). */
const FMP_FETCH_TIMEOUT_MS = 10_000;

/**
 * Process-wide semaphore capping concurrent in-flight FMP requests.
 *
 * WHY HERE: siglens-core's runFundamentalAnalysis fires 13 FMP endpoints
 * concurrently via Promise.all per symbol, and the cron walks symbols serially.
 * That burst reliably trips FMP's 429 rate limiter. Placing this guard at the
 * single HTTP choke point means every caller — regardless of how many symbols
 * or which client are in flight — is covered without duplicating the logic.
 */
const FMP_CONCURRENCY_LIMIT = 4;
let _permits = FMP_CONCURRENCY_LIMIT;
const _waiters: Array<() => void> = [];

function acquire(): Promise<void> {
    if (_permits > 0) {
        _permits--;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => _waiters.push(resolve));
}

function release(): void {
    const next = _waiters.shift();
    if (next !== undefined) {
        // Hand the permit directly to the next waiter rather than incrementing
        // the counter so the waiter resumes without an extra microtask.
        next();
    } else {
        _permits++;
    }
}

/** Maximum attempts total (1 initial + 2 retries). Only 429 is retried. */
const FMP_MAX_ATTEMPTS = 3;

/**
 * Ceiling for a Retry-After header value in milliseconds.
 * Clamps hostile or pathologically large values so the cron cannot stall.
 */
const FMP_MAX_RETRY_AFTER_MS = 10_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the backoff delay (ms) to wait before the next attempt after a 429.
 *
 * Honors the Retry-After header when present and parseable (interpreted as
 * seconds), clamped to FMP_MAX_RETRY_AFTER_MS. Falls back to exponential
 * backoff with jitter: jitter prevents the 13 sibling requests fired by
 * runFundamentalAnalysis from retrying in lockstep and re-tripping the limiter.
 */
function computeBackoffMs(res: Response, attempt: number): number {
    const header = res.headers.get('Retry-After');
    if (header !== null) {
        const parsed = parseInt(header, 10);
        if (!isNaN(parsed)) {
            // Clamp both ends: the value comes from an external server, and a negative
            // one would otherwise retry immediately and hammer the limiter we are backing
            // off from. (An HTTP-date value parses as NaN and falls through to the
            // exponential path below, which is the desired behaviour.)
            return Math.min(Math.max(parsed, 0) * 1000, FMP_MAX_RETRY_AFTER_MS);
        }
    }
    // attempt 1 → ~500ms, attempt 2 → ~1000ms, plus random 0–300ms jitter.
    return 500 * attempt + Math.random() * 300;
}

/** GET FMP /stable/<path>; appends apikey automatically; throws if FMP_API_KEY missing or non-2xx response. */
export async function fmpGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const { apiKey } = readFmpConfig();
    const params = new URLSearchParams({ ...query, apikey: apiKey });
    const url = `${FMP_STABLE_BASE}/${path}?${params.toString()}`;

    for (let attempt = 1; attempt <= FMP_MAX_ATTEMPTS; attempt++) {
        await acquire();
        // Track whether this iteration already released the permit so the
        // finally block does not double-release on the 429 + continue path.
        let released = false;

        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(FMP_FETCH_TIMEOUT_MS),
            });

            if (res.status === 429) {
                // Release the permit BEFORE sleeping so the pool is not idled
                // during the backoff window — other queued requests can proceed.
                release();
                released = true;

                if (attempt === FMP_MAX_ATTEMPTS) {
                    throw new Error(`FMP ${path} 429`);
                }

                await sleep(computeBackoffMs(res, attempt));
                continue; // re-acquire at the top of the next iteration
            }

            if (!res.ok) {
                throw new Error(`FMP ${path} ${res.status}`);
            }

            // Adapter methods narrow the result via explicit field mapping; malformation surfaces as TypeError in the mapper.
            const json = (await res.json()) as unknown;
            release();
            released = true;

            // FMP sometimes returns a 200 with an error object instead of the expected payload.
            // Detect this shape and surface it as a thrown error so callers see status:'error'.
            if (
                json !== null &&
                typeof json === 'object' &&
                !Array.isArray(json) &&
                'Error Message' in json
            ) {
                throw new Error(
                    `FMP ${path}: ${String((json as Record<string, unknown>)['Error Message'])}`,
                );
            }

            return json as T;
        } finally {
            if (!released) {
                release();
            }
        }
    }

    // Unreachable: every branch in the loop either returns, throws, or continues.
    // Required so TypeScript's control-flow analysis sees a definite return path.
    throw new Error(`FMP ${path} 429`);
}
