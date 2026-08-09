import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

const mockFetchOptionsSnapshot = vi.fn();

vi.mock('@y0ngha/siglens-core', () => ({
    runOptionsAnalysis: vi.fn(),
}));

vi.mock('@lib/data/yahoo-options', () => ({
    fetchOptionsSnapshot: mockFetchOptionsSnapshot,
}));

// 'runOptionsAnalysis' from core — aliased to avoid collision with the local function under test.
const { runOptionsAnalysis: coreRun } = await import('@y0ngha/siglens-core');
const { runOptionsAnalysis } = await import('../run-options');

const mockedCore = vi.mocked(coreRun);

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
        expect(mockedCore).not.toHaveBeenCalled();
    });

    it('returns skipped when snapshot has empty chains', async () => {
        mockFetchOptionsSnapshot.mockResolvedValue({ chains: [] });

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
        expect(mockedCore).not.toHaveBeenCalled();
    });

    it('completes full flow with valid snapshot', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-02-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({
            status: 'done',
            result: { impliedVolatility: 0.35 },
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { impliedVolatility: 0.35 } });
        expect(mockedCore).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'NVDA',
                expirationDate: '2025-02-21',
                snapshot,
            }),
        );
    });

    it('returns cached result from core', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({
            status: 'cached',
            result: { putCallRatio: 1.2 },
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { putCallRatio: 1.2 } });
    });

    it('returns skipped when core returns miss_no_trigger', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns skipped when core returns no_chains_error (sanitization found no usable chains)', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({
            status: 'no_chains_error',
            code: 'no_options_chains',
            error: 'snapshot has no usable options chains',
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when fetchOptionsSnapshot throws', async () => {
        mockFetchOptionsSnapshot.mockRejectedValue(new Error('Yahoo API down'));

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: Yahoo API down' });
    });

    it('returns error when core returns limit_error (usage quota exceeded)', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({
            status: 'limit_error',
            code: 'usage_limit_exceeded',
            error: {
                message: 'Daily limit exceeded',
                code: 'analysis_limit_exceeded',
                feature: 'analysisPerDay',
                tier: 'pro',
            },
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result.status).toBe('error');
        // toErrStr은 AnalysisLimitError의 .message를 추출한다(B3).
        expect(result.error).toContain('Daily limit exceeded');
    });

    it('returns error when core returns key_error (BYOK required)', async () => {
        const snapshot = {
            chains: [{ expirationDate: '2025-03-21', calls: [], puts: [] }],
        };
        mockFetchOptionsSnapshot.mockResolvedValue(snapshot);
        mockedCore.mockResolvedValue({
            status: 'key_error',
            code: 'user_api_key_required',
            error: 'BYOK API key required for this model',
            modelId: 'claude-sonnet-4-20250514',
            tier: 'pro',
        } as any);

        const result = await runOptionsAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'BYOK API key required for this model' });
    });
});
