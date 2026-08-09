import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    runFundamentalAnalysis: vi.fn(),
}));

vi.mock('@lib/data/fmp-fundamental', () => ({
    FmpFundamentalClient: vi.fn().mockImplementation(() => ({})),
}));

// 'runFundamentalAnalysis' from core — aliased to avoid collision with the local function under test.
const { runFundamentalAnalysis: coreRun } = await import('@y0ngha/siglens-core');
const { runFundamentalAnalysis } = await import('../run-fundamental');

const mockedCore = vi.mocked(coreRun);

const baseOptions: RunAnalysisOptions = {
    symbol: 'MSFT',
    companyName: 'Microsoft Corporation',
    modelId: 'claude-sonnet-4-20250514' as any,
};

describe('runFundamentalAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result from core', async () => {
        mockedCore.mockResolvedValue({
            status: 'cached',
            result: { peRatio: 35.2 },
        } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { peRatio: 35.2 } });
    });

    it('returns done result when core returns done', async () => {
        mockedCore.mockResolvedValue({ status: 'done', result: { healthScore: 8.5 } } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { healthScore: 8.5 } });
    });

    it('returns skipped when core returns miss_no_trigger', async () => {
        mockedCore.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when core throws (LLM or network failure)', async () => {
        mockedCore.mockRejectedValue(new Error('FMP data unavailable'));

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: FMP data unavailable' });
    });

    it('returns error when core returns fetch_failed', async () => {
        mockedCore.mockResolvedValue({
            status: 'error',
            code: 'fetch_failed',
            error: 'Profile not found for symbol: MSFT',
        } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Profile not found for symbol: MSFT' });
    });

    it('returns error when core returns key_error (BYOK required)', async () => {
        mockedCore.mockResolvedValue({
            status: 'key_error',
            code: 'user_api_key_required',
            error: 'BYOK API key required for this model',
            modelId: 'claude-sonnet-4-20250514',
            tier: 'pro',
        } as any);

        const result = await runFundamentalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'BYOK API key required for this model' });
    });

    it('passes dataProvider to runFundamentalAnalysis (core)', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runFundamentalAnalysis(baseOptions);

        expect(mockedCore).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'MSFT',
                modelId: baseOptions.modelId,
                dataProvider: expect.any(Object),
            }),
        );
    });
});
