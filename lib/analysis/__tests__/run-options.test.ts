import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

const mockFetchOptionsSnapshot = vi.fn();

vi.mock('@y0ngha/siglens-core', () => ({
    submitOptionsAnalysis: vi.fn(),
    pollOptionsAnalysis: vi.fn(),
}));

vi.mock('@lib/data/yahoo-options', () => ({
    fetchOptionsSnapshot: mockFetchOptionsSnapshot,
}));

vi.mock('../poll-until-done', () => ({
    pollUntilDone: vi.fn(),
}));

const { submitOptionsAnalysis, pollOptionsAnalysis } = await import('@y0ngha/siglens-core');
const { pollUntilDone } = await import('../poll-until-done');
const { runOptionsAnalysis } = await import('../run-options');

const mockedSubmit = vi.mocked(submitOptionsAnalysis);
const mockedPoll = vi.mocked(pollUntilDone);

const baseOptions: RunAnalysisOptions = {
    symbol: 'NVDA',
    companyName: 'NVIDIA Corporation',
    modelId: 'claude-sonnet-4-20250514' as any,
};

describe('runOptionsAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns skipped when snapshot is null', async () => {
        mockFetchOptionsSnapshot.mockResolvedValue(null);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
        expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it('returns skipped when snapshot has empty chains', async () => {
        mockFetchOptionsSnapshot.mockResolvedValue({ chains: [] });

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
        expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it('completes full flow with valid snapshot', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-02-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'opt-j-1' } as any);
        mockedPoll.mockResolvedValue({ result: { impliedVolatility: 0.35 } });

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { impliedVolatility: 0.35 } });
        expect(mockedPoll).toHaveBeenCalledWith(pollOptionsAnalysis, 'opt-j-1');
        expect(mockedSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'NVDA',
                expirationDate: '2025-02-21',
                snapshot,
            }),
        );
    });

    it('returns cached result from submit', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedSubmit.mockResolvedValue({
            status: 'cached',
            result: { putCallRatio: 1.2 },
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { putCallRatio: 1.2 } });
    });

    it('returns skipped when submit status is not submitted', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedSubmit.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when fetchOptionsSnapshot throws', async () => {
        mockFetchOptionsSnapshot.mockRejectedValue(new Error('Yahoo API down'));

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: Yahoo API down' });
    });

    it('returns error when poll returns error', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedSubmit.mockResolvedValue({ status: 'submitted', jobId: 'opt-j-2' } as any);
        mockedPoll.mockResolvedValue({ error: 'Options analysis failed' });

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Options analysis failed' });
    });
});
