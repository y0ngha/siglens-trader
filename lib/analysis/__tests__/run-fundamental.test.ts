import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    submitFundamentalAnalysis: vi.fn(),
    pollFundamentalAnalysis: vi.fn(),
}));

vi.mock('@lib/data/fmp-fundamental', () => ({
    FmpFundamentalClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../poll-until-done', () => ({
    pollUntilDone: vi.fn(),
}));

const { submitFundamentalAnalysis, pollFundamentalAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { runFundamentalAnalysis } = await import('../run-fundamental');

const mockedSubmit = vi.mocked(submitFundamentalAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);

const baseOptions: RunAnalysisOptions = {
    symbol: 'MSFT',
    companyName: 'Microsoft Corporation',
    modelId: 'claude-sonnet-4-20250514' as any,
};

describe('runFundamentalAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result from submit', async () => {
        mockedSubmit.mockResolvedValue({
            status: 'cached',
            result: { peRatio: 35.2 },
        } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { peRatio: 35.2 } });
        expect(mockedPoll).not.toHaveBeenCalled();
    });

    it('polls and returns done result when submitted', async () => {
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'fund-j-1' } as any);
        mockedPoll.mockResolvedValue({ result: { healthScore: 8.5 } });

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { healthScore: 8.5 } });
        expect(mockedPoll).toHaveBeenCalledWith(pollFundamentalAnalysis, 'fund-j-1');
    });

    it('returns skipped when submit status is not submitted', async () => {
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when submit throws', async () => {
        mockedSubmit.mockRejectedValue(new Error('FMP data unavailable'));

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: FMP data unavailable' });
    });

    it('returns error when poll returns error', async () => {
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'fund-j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Fundamental analysis timeout' });

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Fundamental analysis timeout' });
    });

    it('passes dataProvider to submitFundamentalAnalysis', async () => {
        mockedSubmit.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runFundamentalAnalysis(baseOptions);

        expect(mockedSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'MSFT',
                modelId: baseOptions.modelId,
                dataProvider: expect.any(Object),
            }),
        );
    });
});
