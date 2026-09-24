import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBars = vi.fn();
vi.mock('../../data/fmp-market-data-provider', () => ({
    getMarketDataProvider: () => ({ getBars }),
}));

import { fetchDailyBars, etDateOf, etDayStart, etMinutesOfDay } from '../daily-bars';

const bar = (date: string, close: number) => ({
    time: Date.parse(date + 'T00:00:00Z') / 1000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
});
// 2026-01-05 14:45 ET (EST)
const NOW = new Date('2026-01-05T19:45:00Z');

describe('fetchDailyBars', () => {
    beforeEach(() => {
        getBars.mockReset();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('requests 400 calendar days of 1Day bars', async () => {
        getBars.mockResolvedValue([bar('2026-01-02', 10)]);
        await fetchDailyBars('NVDA', null, NOW);
        expect(getBars).toHaveBeenCalledWith({
            symbol: 'NVDA',
            timeframe: '1Day',
            from: '2024-12-01',
        });
    });

    it("replaces today's close with the live price and widens high/low", async () => {
        getBars.mockResolvedValue([bar('2026-01-02', 10), bar('2026-01-05', 11)]);
        const out = await fetchDailyBars('NVDA', 13, NOW);
        expect(out).toHaveLength(2);
        expect(out!.at(-1)).toEqual({ date: '2026-01-05', open: 11, high: 13, low: 10, close: 13 });
    });

    it('keeps the wider vendor range when the live price is inside it', async () => {
        getBars.mockResolvedValue([bar('2026-01-05', 11)]);
        const out = await fetchDailyBars('NVDA', 11.5, NOW);
        expect(out!.at(-1)).toEqual({
            date: '2026-01-05',
            open: 11,
            high: 12,
            low: 10,
            close: 11.5,
        });
    });

    it('appends a synthetic today bar when the vendor has none', async () => {
        getBars.mockResolvedValue([bar('2026-01-02', 10)]);
        const out = await fetchDailyBars('NVDA', 12, NOW);
        expect(out!.at(-1)).toEqual({ date: '2026-01-05', open: 12, high: 12, low: 12, close: 12 });
    });

    it('returns the vendor series untouched without a usable live price', async () => {
        getBars.mockResolvedValue([bar('2026-01-02', 10)]);
        expect(await fetchDailyBars('NVDA', null, NOW)).toEqual([
            { date: '2026-01-02', open: 10, high: 11, low: 9, close: 10 },
        ]);
        expect(await fetchDailyBars('NVDA', 0, NOW)).toHaveLength(1);
    });

    it('does not append when the vendor is somehow ahead of today', async () => {
        getBars.mockResolvedValue([bar('2026-01-06', 10)]);
        const out = await fetchDailyBars('NVDA', 12, NOW);
        expect(out).toHaveLength(1);
        expect(out![0]!.close).toBe(10);
    });

    it('returns null on a vendor error, a non-array or an empty series', async () => {
        getBars.mockRejectedValueOnce(new Error('x'));
        expect(await fetchDailyBars('NVDA', 1, NOW)).toBeNull();
        getBars.mockResolvedValueOnce(undefined);
        expect(await fetchDailyBars('NVDA', 1, NOW)).toBeNull();
        getBars.mockResolvedValueOnce([]);
        expect(await fetchDailyBars('NVDA', 1, NOW)).toBeNull();
    });
});

describe('etDateOf', () => {
    it('uses America/New_York, not UTC', () => {
        expect(etDateOf(new Date('2026-01-06T03:00:00Z'))).toBe('2026-01-05');
        expect(etDateOf(new Date('2026-07-06T03:30:00Z'))).toBe('2026-07-05');
    });
});

describe('etDayStart / etMinutesOfDay', () => {
    it('ET midnight is 05:00Z in winter and 04:00Z in summer, including DST switch days', () => {
        expect(etDayStart(new Date('2026-01-05T20:47:00Z')).toISOString()).toBe(
            '2026-01-05T05:00:00.000Z',
        );
        expect(etDayStart(new Date('2026-07-06T19:47:00Z')).toISOString()).toBe(
            '2026-07-06T04:00:00.000Z',
        );
        expect(etDayStart(new Date('2026-03-08T18:00:00Z')).toISOString()).toBe(
            '2026-03-08T05:00:00.000Z',
        );
        expect(etDayStart(new Date('2026-11-01T18:00:00Z')).toISOString()).toBe(
            '2026-11-01T04:00:00.000Z',
        );
    });

    it('etMinutesOfDay reads the ET wall clock', () => {
        expect(etMinutesOfDay(new Date('2026-01-05T20:47:00Z'))).toBe(15 * 60 + 47);
    });
});
