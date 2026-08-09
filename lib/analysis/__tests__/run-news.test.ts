import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

const mockFetchNews = vi.fn();
const mockGetEarningsReports = vi.fn();

vi.mock('@y0ngha/siglens-core', () => ({
    runNewsAnalysis: vi.fn(),
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

vi.mock('../enrich-news-cards', () => ({
    enrichNewsCards: vi.fn(),
}));

// 'runNewsAnalysis' from core — aliased to avoid collision with the local function under test.
const { runNewsAnalysis: coreRun } = await import('@y0ngha/siglens-core');
const { enrichNewsCards } = await import('../enrich-news-cards');
const { runNewsAnalysis } = await import('../run-news');

const mockedCore = vi.mocked(coreRun);
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
        expect(mockedCore).not.toHaveBeenCalled();
    });

    it('returns cached result from runNewsAnalysis (core)', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Tesla earnings beat' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedCore.mockResolvedValue({
            status: 'cached',
            result: { sentiment: 'positive' },
        } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { sentiment: 'positive' } });
    });

    it('completes full flow: fetch news + earnings -> run -> done', async () => {
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
        mockedCore.mockResolvedValue({
            status: 'done',
            result: { overallSentiment: 'bullish' },
        } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { overallSentiment: 'bullish' } });
        expect(mockedCore).toHaveBeenCalledWith(
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

    it('returns skipped when core returns miss_no_trigger', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Some news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedCore.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when core throws (LLM failure)', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Some news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedCore.mockRejectedValue(new Error('API timeout'));

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: API timeout' });
    });

    it('returns error when core returns error status (usage limit)', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'News item' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedCore.mockResolvedValue({
            status: 'error',
            code: 'usage_limit_exceeded',
            error: {
                message: 'Daily limit exceeded',
                code: 'analysis_limit_exceeded',
                feature: 'analysisPerDay',
                tier: 'pro',
            },
        } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result.status).toBe('error');
        // toErrStr은 AnalysisLimitError의 .message를 추출한다(B3).
        expect(result.error).toContain('Daily limit exceeded');
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
        expect(mockedCore).not.toHaveBeenCalled();
    });

    it('forwards deadlineMs to enrichNewsCards', async () => {
        const deadlineMs = Date.now() + 600_000;
        mockFetchNews.mockResolvedValue([{ title: 'news' }]);
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedCore.mockResolvedValue({ status: 'done', result: { ok: true } } as any);

        await runNewsAnalysis({ ...baseOptions, deadlineMs });

        expect(mockedEnrich).toHaveBeenCalledWith(fakeCardStore, 'TSLA', expect.anything(), {
            deadlineMs,
        });
    });

    it('skips the aggregate submission when the deadline has passed', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'news' }]);
        // enrich returns cards but no time remains for the aggregate LLM call
        mockedEnrich.mockResolvedValue(enrichedFixture);
        mockGetEarningsReports.mockResolvedValue([]);

        const result = await runNewsAnalysis({ ...baseOptions, deadlineMs: Date.now() - 1 });

        expect(result).toEqual({ status: 'skipped' });
        expect(mockGetEarningsReports).not.toHaveBeenCalled();
        expect(mockedCore).not.toHaveBeenCalled();
    });
});
