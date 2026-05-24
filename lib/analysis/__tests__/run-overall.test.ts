import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

const mockFetchNews = vi.fn();
const mockGetEarningsReports = vi.fn();
const mockFetchOptionsSnapshot = vi.fn();

vi.mock('@y0ngha/siglens-core', () => ({
    submitOverallAnalysis: vi.fn(),
    pollOverallAnalysis: vi.fn(),
}));

vi.mock('@lib/data/fmp-fundamental', () => ({
    FmpFundamentalClient: vi.fn().mockImplementation(() => ({
        getEarningsReports: mockGetEarningsReports,
    })),
}));

vi.mock('@lib/data/fmp-news', () => ({
    FmpNewsClient: vi.fn().mockImplementation(() => ({
        fetchNews: mockFetchNews,
    })),
}));

vi.mock('@lib/data/yahoo-options', () => ({
    fetchOptionsSnapshot: mockFetchOptionsSnapshot,
}));

vi.mock('../poll-until-done', () => ({
    pollUntilDone: vi.fn(),
}));

const { submitOverallAnalysis, pollOverallAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { runOverallAnalysis } = await import('../run-overall');

const mockedSubmit = vi.mocked(submitOverallAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);

const baseOptions: RunAnalysisOptions = {
    symbol: 'GOOGL',
    companyName: 'Alphabet Inc.',
    modelId: 'claude-sonnet-4-20250514' as any,
};

function setupDefaultMocks() {
    mockFetchNews.mockResolvedValue([{ title: 'Tech earnings strong' }]);
    mockFetchOptionsSnapshot.mockResolvedValue({
        chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
    });
    mockGetEarningsReports.mockResolvedValue([]);
}

describe('runOverallAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result from submit', async () => {
        setupDefaultMocks();
        mockedSubmit.mockResolvedValue({
            status: 'cached',
            result: { overallScore: 72 },
        } as any);

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { overallScore: 72 } });
        expect(mockedPoll).not.toHaveBeenCalled();
    });

    it('polls and returns done when submitted', async () => {
        setupDefaultMocks();
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'ovr-j-1' } as any);
        mockedPoll.mockResolvedValue({ result: { overallScore: 88 } });

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { overallScore: 88 } });
        expect(mockedPoll).toHaveBeenCalledWith(pollOverallAnalysis, 'ovr-j-1');
    });

    it('returns skipped with error for pending_dependencies', async () => {
        setupDefaultMocks();
        mockedSubmit.mockResolvedValue({
            status: 'pending_dependencies',
            pendingJobs: ['tech-j-1', 'news-j-1'],
        } as any);

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped', error: 'Dependencies still pending' });
    });

    it('returns skipped when submit status is miss_no_trigger', async () => {
        setupDefaultMocks();
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when an exception is thrown', async () => {
        mockFetchNews.mockRejectedValue(new Error('Network error'));

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: Network error' });
    });

    it('returns error when poll returns error', async () => {
        setupDefaultMocks();
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'ovr-j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Overall analysis timed out' });

        const result = await runOverallAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Overall analysis timed out' });
    });

    it('passes null snapshot as undefined to submitOverallAnalysis', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'News' }]);
        mockFetchOptionsSnapshot.mockResolvedValue(null);
        mockGetEarningsReports.mockResolvedValue([]);
        mockedSubmit.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runOverallAnalysis(baseOptions);

        expect(mockedSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                optionsSnapshot: undefined,
            }),
        );
    });

    it('builds upcomingCalendar from earnings reports', async () => {
        mockFetchNews.mockResolvedValue([{ title: 'News' }]);
        mockFetchOptionsSnapshot.mockResolvedValue(null);
        mockGetEarningsReports.mockResolvedValue([
            {
                symbol: 'GOOGL',
                earningsDate: '2025-04-29',
                epsActual: 2.1,
                epsEstimated: 2.0,
                revenueActual: 90_000_000_000,
                revenueEstimated: 88_000_000_000,
                lastUpdated: '2025-04-15',
            },
        ]);
        mockedSubmit.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runOverallAnalysis(baseOptions);

        expect(mockedSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                upcomingCalendar: [
                    expect.objectContaining({
                        symbol: 'GOOGL',
                        earningsDate: '2025-04-29',
                        epsActual: 2.1,
                        lastUpdated: '2025-04-15',
                    }),
                ],
            }),
        );
    });
});
