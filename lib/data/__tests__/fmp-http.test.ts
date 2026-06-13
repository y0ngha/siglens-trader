import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@y0ngha/siglens-core', () => ({
    readFmpConfig: () => ({ apiKey: 'test-key' }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    } as Response;
}

describe('fmpGet', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

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
});
