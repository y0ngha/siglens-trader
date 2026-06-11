import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    submitAnalysis: vi.fn(),
    pollAnalysis: vi.fn(),
}));

vi.mock('../poll-until-done', () => ({
    pollUntilDone: vi.fn(),
}));

const mockProvider = { getBars: vi.fn(), getQuote: vi.fn() };
vi.mock('@lib/data/fmp-market-data-provider', () => ({
    getMarketDataProvider: () => mockProvider,
}));

const { submitAnalysis, pollAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { runTechnicalAnalysis } = await import('../run-technical');

const mockedSubmit = vi.mocked(submitAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);

const baseOptions: RunAnalysisOptions = {
    symbol: 'AAPL',
    companyName: 'Apple Inc.',
    modelId: 'claude-sonnet-4-20250514' as any,
};

describe('runTechnicalAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result when submitAnalysis returns cached', async () => {
        mockedSubmit.mockResolvedValue({ status: 'cached', result: { score: 80 } } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { score: 80 } });
        expect(mockedPoll).not.toHaveBeenCalled();
    });

    it('polls and returns done result when submitted', async () => {
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'j-1' } as any);
        mockedPoll.mockResolvedValue({ result: { signal: 'buy' } });

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { signal: 'buy' } });
        expect(mockedPoll).toHaveBeenCalledWith(pollAnalysis, 'j-1');
    });

    it('returns skipped when submitAnalysis returns miss_no_trigger', async () => {
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when submitAnalysis throws', async () => {
        mockedSubmit.mockRejectedValue(new Error('Network failure'));

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: Network failure' });
    });

    it('returns error when poll returns error', async () => {
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Analysis failed on server' });

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Analysis failed on server' });
    });

    it('passes correct arguments to submitAnalysis', async () => {
        mockedSubmit.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runTechnicalAnalysis({ ...baseOptions, userApiKey: 'sk-123' });

        expect(mockedSubmit).toHaveBeenCalledWith('AAPL', 'Apple Inc.', '1Day', false, undefined, {
            modelId: baseOptions.modelId,
            userApiKey: 'sk-123',
            marketDataProvider: mockProvider,
        });
    });
});
