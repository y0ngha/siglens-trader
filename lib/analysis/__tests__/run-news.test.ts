import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

const mockFetchNews = vi.fn();
const mockGetEarningsReports = vi.fn();

vi.mock('@y0ngha/siglens-core', () => ({
    submitNewsAnalysis: vi.fn(),
    pollNewsAnalysis: vi.fn(),
}));

vi.mock('@lib/data/fmp-news', () => ({
    FmpNewsClient: vi.fn().mockImplementation(() => ({
        fetchNews: mockFetchNews,
    })),
}));

vi.mock('@lib/data/fmp-fundamental', () => ({
    FmpFundamentalClient: vi.fn().mockImplementation(() => ({
        getEarningsReports: mockGetEarningsReports,
    })),
}));

vi.mock('../poll-until-done', () => ({
    pollUntilDone: vi.fn(),
}));

vi.mock('../enrich-news-cards', () => ({
    enrichNewsCards: vi.fn(),
}));

const { submitNewsAnalysis, pollNewsAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { enrichNewsCards } = await import('../enrich-news-cards');
const { runNewsAnalysis } = await import('../run-news');

const mockedSubmit = vi.mocked(submitNewsAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);
const mockedEnrich = vi.mocked(enrichNewsCards);

const enrichedFixture = [
    {
        id: 'n1',
        symbol: 'TSLA',
        source: 'site',
        url: 'https://x/n1',
        publishedAt: '2026-06-15T00:00:00Z',
        titleEn: 't',
        bodyEn: 'b',
        card: {
            titleKo: 't',
            bodyKo: null,
            summaryKo: 's',
            sentiment: 'neutral',
            category: 'other',
            priceImpact: 'low',
        },
    } as any,
];

const fakeCardStore = {
    getCards: vi.fn(async () => new Map()),
    upsertCards: vi.fn(async () => undefined),
};

const baseOptions: RunAnalysisOptions = {
    symbol: 'TSLA',
    companyName: 'Tesla Inc.',
    modelId: 'claude-sonnet-4-20250514' as any,
    cardStore: fakeCardStore,
};

describe('runNewsAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns skipped when no news available', async () => {
        mockFetchNews.mockResolvedValue([]);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
        expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it('returns cached result from submitNewsAnalysis', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Tesla earnings beat' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({
            status: 'cached',
            result: { sentiment: 'positive' },
        } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { sentiment: 'positive' } });
    });

    it('completes full flow: fetch news + earnings -> submit -> poll -> done', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Breaking news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([
            {
                symbol: 'TSLA',
                earningsDate: '2025-01-20',
                epsActual: 1.5,
                epsEstimated: 1.3,
                revenueActual: 25_000_000_000,
                revenueEstimated: 24_000_000_000,
                lastUpdated: '2025-01-15',
            },
        ]);
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'news-j-1' } as any);
        mockedPoll.mockResolvedValue({ result: { overallSentiment: 'bullish' } });

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { overallSentiment: 'bullish' } });
        expect(mockedPoll).toHaveBeenCalledWith(pollNewsAnalysis, 'news-j-1');
        expect(mockedSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'TSLA',
                upcomingCalendar: [
                    expect.objectContaining({
                        symbol: 'TSLA',
                        earningsDate: '2025-01-20',
                        lastUpdated: '2025-01-15',
                    }),
                ],
            }),
        );
    });

    it('returns skipped when submit status is not submitted', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Some news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when submit throws', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Some news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockRejectedValue(new Error('API timeout'));

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: API timeout' });
    });

    it('returns error when poll returns error', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'News item' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'news-j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Worker crashed' });

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Worker crashed' });
    });

    it('returns error when cardStore not provided', async () => {
        const optsNoStore: RunAnalysisOptions = { ...baseOptions };
        delete optsNoStore.cardStore;
        const result = await runNewsAnalysis(optsNoStore);
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/cardStore not provided/);
        expect(mockFetchNews).not.toHaveBeenCalled();
    });

    it('returns skipped when enrich returns empty', async () => {
        mockFetchNews.mockResolvedValue([
            {
                id: 'n1',
                symbol: 'TSLA',
                source: 's',
                url: 'u',
                publishedAt: 'p',
                titleEn: 't',
                bodyEn: 'b',
            },
        ]);
        mockedEnrich.mockResolvedValue([]);
        const result = await runNewsAnalysis(baseOptions);
        expect(result.status).toBe('skipped');
        expect(mockedSubmit).not.toHaveBeenCalled();
    });
});
