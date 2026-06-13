import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../fmp-http', () => ({
    fmpGet: vi.fn(),
}));

const { fmpGet } = await import('../fmp-http');
const { FmpMarketProvider, getMarketDataProvider } = await import('../fmp-market-data-provider');

const mockedFmpGet = vi.mocked(fmpGet);

function utcSeconds(iso: string): number {
    return Math.floor(new Date(iso).getTime() / 1000);
}

describe('FmpMarketProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getBars — 1Day', () => {
        it('maps EOD bars to UTC-midnight time, returns them chronologically, and appends a newer today-quote bar', async () => {
            // FMP returns daily bars newest-first.
            const eod = [
                { date: '2025-06-13', open: 10, high: 12, low: 9, close: 11, volume: 100 },
                { date: '2025-06-12', open: 8, high: 11, low: 7, close: 10, volume: 90 },
            ];
            // quote timestamp is 2025-06-16 (newer than the last EOD bar 2025-06-13)
            const quote = [
                {
                    price: 13,
                    open: 11,
                    dayHigh: 14,
                    dayLow: 10,
                    volume: 120,
                    timestamp: utcSeconds('2025-06-16T18:00:00Z'),
                    changePercentage: 1.5,
                    name: 'Apple Inc.',
                },
            ];
            mockedFmpGet.mockImplementation(async (path: string) => {
                if (path === 'historical-price-eod/full') return eod as never;
                if (path === 'quote') return quote as never;
                throw new Error(`unexpected path ${path}`);
            });

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Day' });

            // chronological order (oldest first), plus the appended today bar
            expect(bars).toHaveLength(3);
            expect(bars[0]!.time).toBe(utcSeconds('2025-06-12T00:00:00Z'));
            expect(bars[0]!.close).toBe(10);
            expect(bars[1]!.time).toBe(utcSeconds('2025-06-13T00:00:00Z'));
            expect(bars[1]!.close).toBe(11);
            // appended today bar at UTC-midnight of 2025-06-16, close = quote.price
            expect(bars[2]!.time).toBe(utcSeconds('2025-06-16T00:00:00Z'));
            expect(bars[2]!.close).toBe(13);
            expect(bars[2]!.high).toBe(14);
        });

        it('does NOT append the today-quote bar when it is not newer than the last EOD bar', async () => {
            const eod = [
                { date: '2025-06-16', open: 10, high: 12, low: 9, close: 11, volume: 100 },
            ];
            const quote = [
                {
                    price: 13,
                    open: 11,
                    dayHigh: 14,
                    dayLow: 10,
                    volume: 120,
                    timestamp: utcSeconds('2025-06-16T18:00:00Z'),
                    changePercentage: 1.5,
                    name: 'Apple Inc.',
                },
            ];
            mockedFmpGet.mockImplementation(async (path: string) => {
                if (path === 'historical-price-eod/full') return eod as never;
                if (path === 'quote') return quote as never;
                throw new Error(`unexpected path ${path}`);
            });

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Day' });

            expect(bars).toHaveLength(1);
            expect(bars[0]!.time).toBe(utcSeconds('2025-06-16T00:00:00Z'));
        });

        it('does NOT fetch a today-quote bar when a `before` bound is supplied', async () => {
            const eod = [
                { date: '2025-01-10', open: 10, high: 12, low: 9, close: 11, volume: 100 },
            ];
            mockedFmpGet.mockImplementation(async (path: string) => {
                if (path === 'historical-price-eod/full') return eod as never;
                throw new Error(`unexpected path ${path}`);
            });

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({
                symbol: 'AAPL',
                timeframe: '1Day',
                before: '2025-01-15T00:00:00Z',
            });

            expect(bars).toHaveLength(1);
            // 'quote' must not be requested
            const calledPaths = mockedFmpGet.mock.calls.map((c) => c[0]);
            expect(calledPaths).not.toContain('quote');
            // 'to' bound forwarded
            expect(mockedFmpGet).toHaveBeenCalledWith(
                'historical-price-eod/full',
                expect.objectContaining({ symbol: 'AAPL', to: '2025-01-15' }),
            );
        });
    });

    describe('getBars — intraday', () => {
        it('converts EDT (summer) timestamps ET→UTC (-4) and returns them chronologically', async () => {
            // FMP returns intraday newest-first; ET wall-clock times in June → EDT (-4)
            const raw = [
                { date: '2025-06-13 10:00:00', open: 10, high: 12, low: 9, close: 11, volume: 100 },
                { date: '2025-06-13 09:00:00', open: 8, high: 11, low: 7, close: 10, volume: 90 },
            ];
            mockedFmpGet.mockResolvedValueOnce(raw as never);

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Hour' });

            expect(mockedFmpGet).toHaveBeenCalledWith(
                'historical-chart/1hour',
                expect.objectContaining({ symbol: 'AAPL' }),
            );
            // reversed → chronological
            expect(bars).toHaveLength(2);
            // 09:00 ET (EDT -4) == 13:00 UTC
            expect(bars[0]!.time).toBe(utcSeconds('2025-06-13T13:00:00Z'));
            expect(bars[0]!.close).toBe(10);
            // 10:00 ET (EDT -4) == 14:00 UTC
            expect(bars[1]!.time).toBe(utcSeconds('2025-06-13T14:00:00Z'));
        });

        it('converts EST (winter) timestamps ET→UTC (-5)', async () => {
            // January → EST (-5)
            const raw = [
                { date: '2025-01-15 09:00:00', open: 8, high: 11, low: 7, close: 10, volume: 90 },
            ];
            mockedFmpGet.mockResolvedValueOnce(raw as never);

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Hour' });

            // 09:00 ET (EST -5) == 14:00 UTC
            expect(bars[0]!.time).toBe(utcSeconds('2025-01-15T14:00:00Z'));
        });

        it('returns [] when FMP returns a non-array intraday response', async () => {
            mockedFmpGet.mockResolvedValueOnce({ error: 'rate limit' } as never);

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '5Min' });

            expect(bars).toEqual([]);
        });
    });

    describe('getQuote', () => {
        it('maps FMP quote fields to a MarketQuote', async () => {
            mockedFmpGet.mockResolvedValueOnce([
                { price: 150, changePercentage: 2.5, name: 'Apple Inc.' },
            ] as never);

            const provider = new FmpMarketProvider();
            const quote = await provider.getQuote('AAPL');

            expect(quote).toEqual({
                symbol: 'AAPL',
                price: 150,
                changesPercentage: 2.5,
                name: 'Apple Inc.',
            });
        });

        it('returns null on empty response', async () => {
            mockedFmpGet.mockResolvedValueOnce([] as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('AAPL')).toBeNull();
        });

        it('returns null on a non-array response', async () => {
            mockedFmpGet.mockResolvedValueOnce(null as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('AAPL')).toBeNull();
        });

        it('returns null (catch path) when fmpGet throws', async () => {
            mockedFmpGet.mockRejectedValueOnce(new Error('network'));

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('AAPL')).toBeNull();
        });

        it('returns null when price is NaN', async () => {
            mockedFmpGet.mockResolvedValueOnce([
                { price: NaN, changePercentage: 0, name: 'Broken Corp.' },
            ] as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('BRKN')).toBeNull();
        });

        it('returns null when price is Infinity', async () => {
            mockedFmpGet.mockResolvedValueOnce([
                { price: Infinity, changePercentage: 0, name: 'Broken Corp.' },
            ] as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('BRKN')).toBeNull();
        });

        it('returns null when price is zero', async () => {
            mockedFmpGet.mockResolvedValueOnce([
                { price: 0, changePercentage: 0, name: 'Broken Corp.' },
            ] as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('BRKN')).toBeNull();
        });

        it('returns null when price is negative', async () => {
            mockedFmpGet.mockResolvedValueOnce([
                { price: -5, changePercentage: 0, name: 'Broken Corp.' },
            ] as never);

            const provider = new FmpMarketProvider();
            expect(await provider.getQuote('BRKN')).toBeNull();
        });
    });

    describe('getBars — bar OHLCV NaN filtering', () => {
        it('drops intraday bars with non-finite OHLCV and keeps valid ones', async () => {
            const raw = [
                // valid bar (newest first — reversed to chronological)
                { date: '2025-06-13 10:00:00', open: 10, high: 12, low: 9, close: 11, volume: 100 },
                // bar with NaN close — should be dropped
                { date: '2025-06-13 09:00:00', open: 8, high: 11, low: 7, close: NaN, volume: 90 },
                // bar with Infinity volume — should be dropped
                {
                    date: '2025-06-13 08:00:00',
                    open: 7,
                    high: 10,
                    low: 6,
                    close: 9,
                    volume: Infinity,
                },
            ];
            mockedFmpGet.mockResolvedValueOnce(raw as never);

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Hour' });

            expect(bars).toHaveLength(1);
            expect(bars[0]!.close).toBe(11);
        });

        it('drops daily bars with non-finite OHLCV and keeps valid ones', async () => {
            const eod = [
                { date: '2025-06-13', open: 10, high: 12, low: 9, close: 11, volume: 100 },
                // bar with NaN open — should be dropped
                { date: '2025-06-12', open: NaN, high: 11, low: 7, close: 10, volume: 90 },
            ];
            const quote = [
                {
                    price: 13,
                    open: 11,
                    dayHigh: 14,
                    dayLow: 10,
                    volume: 120,
                    timestamp: utcSeconds('2025-06-14T18:00:00Z'),
                    changePercentage: 1.5,
                    name: 'Apple Inc.',
                },
            ];
            mockedFmpGet.mockImplementation(async (path: string) => {
                if (path === 'historical-price-eod/full') return eod as never;
                if (path === 'quote') return quote as never;
                throw new Error(`unexpected path ${path}`);
            });

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '1Day' });

            // Only the valid EOD bar + today's quote bar
            expect(bars).toHaveLength(2);
            expect(bars[0]!.close).toBe(11);
            expect(bars[1]!.close).toBe(13);
        });

        it('returns empty array when all intraday bars are malformed', async () => {
            const raw = [
                {
                    date: '2025-06-13 10:00:00',
                    open: NaN,
                    high: NaN,
                    low: NaN,
                    close: NaN,
                    volume: NaN,
                },
            ];
            mockedFmpGet.mockResolvedValueOnce(raw as never);

            const provider = new FmpMarketProvider();
            const bars = await provider.getBars({ symbol: 'AAPL', timeframe: '5Min' });

            expect(bars).toEqual([]);
        });
    });

    describe('getMarketDataProvider', () => {
        it('returns a singleton instance', () => {
            const a = getMarketDataProvider();
            const b = getMarketDataProvider();
            expect(a).toBe(b);
            expect(a).toBeInstanceOf(FmpMarketProvider);
        });
    });
});
