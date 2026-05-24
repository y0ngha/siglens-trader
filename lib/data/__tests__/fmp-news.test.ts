import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawFmpNews, RawFmpEarningsReport } from '../fmp-types';

const mockFmpGet = vi.fn();
vi.mock('../fmp-http', () => ({
    fmpGet: (...args: unknown[]) => mockFmpGet(...args),
}));

describe('FmpNewsClient', () => {
    beforeEach(() => {
        mockFmpGet.mockReset();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('fetchNews', () => {
        it('returns mapped NewsItem array', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            const raw: RawFmpNews[] = [
                {
                    symbol: 'AAPL',
                    publishedDate: '2025-06-01 10:00:00',
                    title: 'Apple rises',
                    site: 'Reuters',
                    text: 'Article body',
                    url: 'https://example.com/article1',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.fetchNews('AAPL', '24h');

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                symbol: 'AAPL',
                source: 'Reuters',
                url: 'https://example.com/article1',
                titleEn: 'Apple rises',
                bodyEn: 'Article body',
            });
            expect(result[0].id).toBeDefined();
            expect(result[0].publishedAt).toBeDefined();
        });

        it('filters articles older than the time range cutoff', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            const raw: RawFmpNews[] = [
                {
                    symbol: 'AAPL',
                    publishedDate: '2025-06-01 10:00:00',
                    title: 'Recent',
                    site: 'Bloomberg',
                    text: null,
                    url: 'https://example.com/recent',
                },
                {
                    symbol: 'AAPL',
                    publishedDate: '2025-05-01 10:00:00',
                    title: 'Old',
                    site: 'Bloomberg',
                    text: null,
                    url: 'https://example.com/old',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.fetchNews('AAPL', '24h');

            expect(result).toHaveLength(1);
            expect(result[0].titleEn).toBe('Recent');
        });

        it('returns empty array when FMP returns no articles', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.fetchNews('AAPL', '7d');

            expect(result).toEqual([]);
        });

        it('passes correct limit per range', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            mockFmpGet.mockResolvedValueOnce([]);

            await client.fetchNews('TSLA', '30d');

            expect(mockFmpGet).toHaveBeenCalledWith('news/stock', {
                symbols: 'TSLA',
                limit: '300',
            });
        });
    });

    describe('fetchEarningsReport', () => {
        it('returns earnings report when available', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            const raw: RawFmpEarningsReport[] = [
                {
                    symbol: 'AAPL',
                    date: '2025-07-25',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.fetchEarningsReport('AAPL');

            expect(result).toEqual({
                symbol: 'AAPL',
                earningsDate: '2025-07-25',
            });
        });

        it('falls back to earningsDate field when date is missing', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            const raw: RawFmpEarningsReport[] = [
                {
                    symbol: 'MSFT',
                    earningsDate: '2025-08-01',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.fetchEarningsReport('MSFT');

            expect(result).toEqual({
                symbol: 'MSFT',
                earningsDate: '2025-08-01',
            });
        });

        it('returns null when FMP returns empty array', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.fetchEarningsReport('AAPL');

            expect(result).toBeNull();
        });

        it('returns null when both date fields are missing', async () => {
            const { FmpNewsClient } = await import('../fmp-news');
            const client = new FmpNewsClient();
            const raw: RawFmpEarningsReport[] = [{ symbol: 'NVDA' }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.fetchEarningsReport('NVDA');

            expect(result).toBeNull();
        });
    });
});

describe('normalizeFmpPublishedDate', () => {
    it('normalizes a zoneless date string as Eastern time', async () => {
        const { normalizeFmpPublishedDate } = await import('../fmp-news');
        // 2025-01-15 14:30:00 ET (EST = UTC-5) → 2025-01-15T19:30:00.000Z
        const result = normalizeFmpPublishedDate('2025-01-15 14:30:00');
        expect(result).toBe('2025-01-15T19:30:00.000Z');
    });

    it('returns ISO string as-is when already has timezone info', async () => {
        const { normalizeFmpPublishedDate } = await import('../fmp-news');
        const result = normalizeFmpPublishedDate('2025-06-01T10:00:00.000Z');
        expect(result).toBe('2025-06-01T10:00:00.000Z');
    });

    it('throws on completely invalid date string', async () => {
        const { normalizeFmpPublishedDate } = await import('../fmp-news');
        expect(() => normalizeFmpPublishedDate('not-a-date')).toThrow(
            'Invalid FMP publishedDate: not-a-date',
        );
    });
});

describe('hashUrlToId', () => {
    it('produces a stable 32-char base64url ID', async () => {
        const { hashUrlToId } = await import('../fmp-news');
        const id1 = hashUrlToId('https://example.com/article');
        const id2 = hashUrlToId('https://example.com/article');
        expect(id1).toBe(id2);
        expect(id1).toHaveLength(32);
    });

    it('produces different IDs for different URLs', async () => {
        const { hashUrlToId } = await import('../fmp-news');
        const id1 = hashUrlToId('https://example.com/a');
        const id2 = hashUrlToId('https://example.com/b');
        expect(id1).not.toBe(id2);
    });
});

describe('computeCutoff', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns correct cutoff for 24h range', async () => {
        const { computeCutoff } = await import('../fmp-news');
        const cutoff = computeCutoff('24h');
        expect(cutoff.toISOString()).toBe('2025-05-31T12:00:00.000Z');
    });

    it('returns correct cutoff for 7d range', async () => {
        const { computeCutoff } = await import('../fmp-news');
        const cutoff = computeCutoff('7d');
        expect(cutoff.toISOString()).toBe('2025-05-25T12:00:00.000Z');
    });

    it('returns correct cutoff for 30d range', async () => {
        const { computeCutoff } = await import('../fmp-news');
        const cutoff = computeCutoff('30d');
        expect(cutoff.toISOString()).toBe('2025-05-02T12:00:00.000Z');
    });
});
