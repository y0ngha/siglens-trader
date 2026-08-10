import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    runCongressTrend: vi.fn(),
}));

vi.mock('@lib/data/fmp-congress', () => ({
    FmpCongressTradesClient: vi.fn().mockImplementation(() => ({})),
}));

// 'runCongressTrend' from core — aliased to avoid collision with the local function under test.
const { runCongressTrend: coreRun } = await import('@y0ngha/siglens-core');
const { runCongressAnalysis } = await import('../run-congress');

const mockedCore = vi.mocked(coreRun);

const baseOptions: RunAnalysisOptions = {
    symbol: 'AAPL',
    companyName: 'Apple Inc.',
    modelId: 'deepseek-v4-flash' as any,
};

describe('runCongressAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result from core', async () => {
        mockedCore.mockResolvedValue({
            status: 'cached',
            result: { summaryKo: '매수 증가', overallSentiment: 'bullish' },
        } as any);

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({
            status: 'cached',
            result: { summaryKo: '매수 증가', overallSentiment: 'bullish' },
        });
    });

    it('returns done result when core returns done', async () => {
        mockedCore.mockResolvedValue({
            status: 'done',
            result: { summaryKo: '중립적', overallSentiment: 'neutral' },
        } as any);

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({
            status: 'done',
            result: { summaryKo: '중립적', overallSentiment: 'neutral' },
        });
    });

    it('returns skipped when core returns no_trades', async () => {
        mockedCore.mockResolvedValue({ status: 'no_trades' } as any);

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns skipped when core returns miss_no_trigger', async () => {
        mockedCore.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when core returns fetch_failed', async () => {
        mockedCore.mockResolvedValue({
            status: 'error',
            code: 'fetch_failed',
            error: 'FMP congress endpoint returned 503',
        } as any);

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({
            status: 'error',
            error: 'FMP congress endpoint returned 503',
        });
    });

    it('returns error when core throws (LLM or network failure)', async () => {
        mockedCore.mockRejectedValue(new Error('AI provider timeout'));

        const result = await runCongressAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: AI provider timeout' });
    });

    it('passes tier, reasoning, and dataProvider to runCongressTrend (core)', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runCongressAnalysis(baseOptions);

        expect(mockedCore).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'AAPL',
                modelId: baseOptions.modelId,
                tier: 'pro',
                reasoning: true,
                dataProvider: expect.any(Object),
            }),
        );
    });

    it('forwards userApiKey when provided', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runCongressAnalysis({ ...baseOptions, userApiKey: 'sk-custom-key' });

        expect(mockedCore).toHaveBeenCalledWith(
            expect.objectContaining({ userApiKey: 'sk-custom-key' }),
        );
    });

    it('forwards reasoning override when provided', async () => {
        mockedCore.mockResolvedValue({ status: 'cached', result: {} } as any);

        await runCongressAnalysis({ ...baseOptions, reasoning: false });

        expect(mockedCore).toHaveBeenCalledWith(expect.objectContaining({ reasoning: false }));
    });
});
