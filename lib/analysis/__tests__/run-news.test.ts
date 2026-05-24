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

const { submitNewsAnalysis, pollNewsAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { runNewsAnalysis } = await import('../run-news');

const mockedSubmit = vi.mocked(submitNewsAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);

const baseOptions: RunAnalysisOptions = {
    symbol: 'TSLA',
    companyName: 'Tesla Inc.',
    modelId: 'claude-sonnet-4-20250514' as any,
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
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when submit throws', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'Some news' }]);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockRejectedValue(new Error('API timeout'));

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: API timeout' });
    });

    it('returns error when poll returns error', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'News item' }]);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'news-j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Worker crashed' });

        const result = await runNewsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Worker crashed' });
    });
});
