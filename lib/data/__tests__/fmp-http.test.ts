import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@y0ngha/siglens-core', () => ({
    readFmpConfig: () => ({ apiKey: 'test-key' }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Creates a minimal Response-shaped mock for a successful or error status. */
function mockResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

/**
 * Creates a 429 response mock.
 * @param retryAfterSeconds — when provided, the Retry-After header returns that value as a string.
 */
function mock429(retryAfterSeconds?: number): Response {
    return {
        ok: false,
        status: 429,
        headers: {
            get: (name: string) =>
                name === 'Retry-After' && retryAfterSeconds !== undefined
                    ? String(retryAfterSeconds)
                    : null,
        },
        json: () => Promise.resolve({}),
    } as unknown as Response;
}

describe('fmpGet', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // --- existing behaviour ---

    it('returns parsed JSON on successful fetch', async () => {
        const { fmpGet } = await import('../fmp-http');
        const payload = [{ symbol: 'AAPL', price: 150 }];
        mockFetch.mockResolvedValueOnce(mockResponse(payload));

        const result = await fmpGet<typeof payload>('profile', { symbol: 'AAPL' });

        expect(result).toEqual(payload);
    });

    it('appends apikey to query params', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await fmpGet('profile', { symbol: 'TSLA' });

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        const url = new URL(calledUrl);
        expect(url.searchParams.get('apikey')).toBe('test-key');
        expect(url.searchParams.get('symbol')).toBe('TSLA');
    });

    it('uses the correct FMP stable base URL', async () => {
        const { fmpGet, FMP_STABLE_BASE } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await fmpGet('earnings', { symbol: 'MSFT' });

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl.startsWith(`${FMP_STABLE_BASE}/earnings`)).toBe(true);
    });

    it('throws on non-2xx response', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse({ error: 'not found' }, 404));

        await expect(fmpGet('profile', { symbol: 'XXX' })).rejects.toThrow('FMP profile 404');
    });

    it('passes AbortSignal.timeout for request timeout', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await fmpGet('profile', {});

        const calledOptions = mockFetch.mock.calls[0][1] as RequestInit;
        expect(calledOptions.signal).toBeDefined();
    });

    it('works with empty query params', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse({ data: true }));

        const result = await fmpGet<{ data: boolean }>('some-path');

        expect(result).toEqual({ data: true });
        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).toContain('apikey=test-key');
    });

    it('throws when 200 response body contains an FMP "Error Message" key', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(
            mockResponse({
                'Error Message': 'Invalid API KEY. Please retry or visit our documentation.',
            }),
        );

        await expect(fmpGet('quote', { symbol: 'AAPL' })).rejects.toThrow(
            'Invalid API KEY. Please retry or visit our documentation.',
        );
    });

    it('does NOT throw for a valid array response (no Error Message key)', async () => {
        const { fmpGet } = await import('../fmp-http');
        const payload = [{ symbol: 'AAPL', price: 150 }];
        mockFetch.mockResolvedValueOnce(mockResponse(payload));

        const result = await fmpGet('quote', { symbol: 'AAPL' });
        expect(result).toEqual(payload);
    });

    it('does NOT throw for a valid object response without Error Message key', async () => {
        const { fmpGet } = await import('../fmp-http');
        const payload = { symbol: 'AAPL', marketCap: 3_000_000_000_000 };
        mockFetch.mockResolvedValueOnce(mockResponse(payload));

        const result = await fmpGet('profile', { symbol: 'AAPL' });
        expect(result).toEqual(payload);
    });

    // --- 429 retry ---

    it('retries once on 429 and resolves with the payload from the subsequent 200', async () => {
        vi.useFakeTimers();
        const { fmpGet } = await import('../fmp-http');
        const payload = { ok: true };
        mockFetch.mockResolvedValueOnce(mock429()).mockResolvedValueOnce(mockResponse(payload));

        const promise = fmpGet<typeof payload>('stock-peers');
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual(payload);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws FMP <path> 429 after three consecutive 429 responses', async () => {
        vi.useFakeTimers();
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValue(mock429());

        const promise = fmpGet('grades-consensus');
        // Attach the rejection handler before running timers so the rejection
        // is not considered unhandled while timers are being processed.
        const expectation = expect(promise).rejects.toThrow('FMP grades-consensus 429');
        await vi.runAllTimersAsync();
        await expectation;

        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('rejects immediately on 500 without retrying', async () => {
        const { fmpGet } = await import('../fmp-http');
        mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

        await expect(fmpGet('profile')).rejects.toThrow('FMP profile 500');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // --- concurrency ---

    it('concurrency never exceeds 4 with 12 simultaneous calls', async () => {
        let inFlight = 0;
        let maxInFlight = 0;

        // Track the number of fetch calls currently in progress.
        // inFlight++ happens synchronously when the mock is entered;
        // inFlight-- happens when the mock promise resolves (one microtask later).
        // maxInFlight is therefore captured at the true concurrent peak.
        mockFetch.mockImplementation(() => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return Promise.resolve(mockResponse([])).then((res) => {
                inFlight--;
                return res;
            });
        });

        const { fmpGet } = await import('../fmp-http');
        const calls = Array.from({ length: 12 }, () => fmpGet('test'));
        await Promise.all(calls);

        expect(maxInFlight).toBeLessThanOrEqual(4);
        expect(maxInFlight).toBeGreaterThan(0); // sanity: calls actually ran
    });

    // --- Retry-After header ---

    it('honors Retry-After header (1s) and retries after that delay', async () => {
        vi.useFakeTimers();
        const { fmpGet } = await import('../fmp-http');
        const payload = { honored: true };
        mockFetch
            .mockResolvedValueOnce(mock429(1)) // Retry-After: 1s
            .mockResolvedValueOnce(mockResponse(payload));

        const promise = fmpGet<typeof payload>('profile');
        // Advance past the 1s Retry-After delay; without honoring the header
        // the exponential backoff (~500ms + jitter) would also fire by 1001ms,
        // so this test focuses on the "header present → resolution happens" path.
        await vi.advanceTimersByTimeAsync(1_001);
        const result = await promise;

        expect(result).toEqual(payload);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clamps Retry-After values above 10s to the 10s ceiling', async () => {
        vi.useFakeTimers();
        const { fmpGet } = await import('../fmp-http');
        const payload = { clamped: true };
        // Retry-After: 100s — unclamped this would sleep for 100 000ms, meaning
        // advancing only 10 001ms would leave the promise pending forever.
        mockFetch.mockResolvedValueOnce(mock429(100)).mockResolvedValueOnce(mockResponse(payload));

        const promise = fmpGet<typeof payload>('profile');
        await vi.advanceTimersByTimeAsync(10_001);
        const result = await promise;

        expect(result).toEqual(payload);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
