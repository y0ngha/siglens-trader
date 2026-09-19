import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    runFundamentalAnalysis: vi.fn(),
}));

vi.mock('@lib/data/fmp-fundamental', () => ({
    FmpFundamentalClient: vi.fn().mockImplementation(() => ({})),
}));

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock('@lib/data/fmp-market-data-provider', () => ({
    getMarketDataProvider: () => ({ getQuote: mockGetQuote }),
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

    it('passes currentPrice as a lazy getter — no quote fetched unless core calls it', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);
        mockGetQuote.mockResolvedValue({
            price: 412.5,
            changesPercentage: 1,
            symbol: 'MSFT',
            name: 'x',
        });

        await runFundamentalAnalysis(baseOptions);

        const opts = mockedCore.mock.calls.find((c) => c[0].symbol === 'MSFT')![0];
        expect(typeof opts.currentPrice).toBe('function');
        expect(mockGetQuote).not.toHaveBeenCalled();
        const getter = opts.currentPrice as () => Promise<number | null>;
        await expect(getter()).resolves.toBe(412.5);
        expect(mockGetQuote).toHaveBeenCalledWith('MSFT');
    });

    it('the getter resolves null for a missing quote or a non-positive price', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);
        await runFundamentalAnalysis(baseOptions);
        const getter = mockedCore.mock.calls.find((c) => c[0].symbol === 'MSFT')![0]
            .currentPrice as () => Promise<number | null>;

        mockGetQuote.mockResolvedValueOnce(null);
        await expect(getter()).resolves.toBeNull();
        mockGetQuote.mockResolvedValueOnce({
            price: 0,
            changesPercentage: 0,
            symbol: 'MSFT',
            name: 'x',
        });
        await expect(getter()).resolves.toBeNull();
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
