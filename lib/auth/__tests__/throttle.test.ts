import { describe, it, expect, beforeEach } from 'vitest';
import {
    MAX_FAILED_ATTEMPTS,
    THROTTLE_WINDOW_MS,
    clearFailures,
    clientKey,
    isThrottled,
    recordFailure,
    resetThrottle,
    retryAfterSeconds,
} from '../throttle';

const KEY = '203.0.113.7';
const T0 = 1_700_000_000_000;

describe('clientKey', () => {
    it("prefers Cloudflare's real-client header", () => {
        const req = new Request('https://example.com', {
            headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' },
        });
        expect(clientKey(req)).toBe('203.0.113.7');
    });

    it('falls back to the first x-forwarded-for hop', () => {
        const req = new Request('https://example.com', {
            headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        });
        expect(clientKey(req)).toBe('203.0.113.9');
    });

    it('buckets unidentifiable clients together rather than exempting them', () => {
        expect(clientKey(new Request('https://example.com'))).toBe('unknown');
    });
});

describe('failed-login throttle', () => {
    beforeEach(() => {
        resetThrottle();
    });

    it('allows attempts up to the limit', () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) recordFailure(KEY, T0);
        expect(isThrottled(KEY, T0)).toBe(false);
    });

    it('locks out once the limit is reached', () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) recordFailure(KEY, T0);
        expect(isThrottled(KEY, T0)).toBe(true);
    });

    it('throttles each client independently', () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) recordFailure(KEY, T0);
        expect(isThrottled('198.51.100.4', T0)).toBe(false);
    });

    it('reports the seconds left in the window', () => {
        recordFailure(KEY, T0);
        expect(retryAfterSeconds(KEY, T0 + 60_000)).toBe(THROTTLE_WINDOW_MS / 1000 - 60);
        expect(retryAfterSeconds('nobody', T0)).toBe(0);
    });

    it('does not extend the window on later failures', () => {
        recordFailure(KEY, T0);
        for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) recordFailure(KEY, T0 + i * 1_000);

        expect(isThrottled(KEY, T0 + THROTTLE_WINDOW_MS - 1)).toBe(true);
        expect(isThrottled(KEY, T0 + THROTTLE_WINDOW_MS)).toBe(false);
    });

    it('clears the bucket on a successful login', () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) recordFailure(KEY, T0);
        clearFailures(KEY);
        expect(isThrottled(KEY, T0)).toBe(false);
    });
});
