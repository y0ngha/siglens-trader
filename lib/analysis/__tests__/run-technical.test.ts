import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions } from '../types';

vi.mock('@y0ngha/siglens-core', () => ({
    runAnalysis: vi.fn(),
}));

const mockProvider = { getBars: vi.fn(), getQuote: vi.fn() };
vi.mock('@lib/data/fmp-market-data-provider', () => ({
    getMarketDataProvider: () => mockProvider,
}));

const { runAnalysis } = await import('@y0ngha/siglens-core');
const { runTechnicalAnalysis } = await import('../run-technical');

const mockedRun = vi.mocked(runAnalysis);

const baseOptions: RunAnalysisOptions = {
    symbol: 'AAPL',
    companyName: 'Apple Inc.',
    modelId: 'claude-sonnet-4-20250514' as any,
};

describe('runTechnicalAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns cached result when runAnalysis returns cached', async () => {
        mockedRun.mockResolvedValue({
            status: 'cached',
            result: { score: 80 },
            lockedInfoDepth: [],
        } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'cached', result: { score: 80 } });
    });

    it('returns done result when runAnalysis returns done', async () => {
        mockedRun.mockResolvedValue({
            status: 'done',
            result: { signal: 'buy' },
            lockedInfoDepth: [],
        } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'done', result: { signal: 'buy' } });
    });

    it('returns skipped when runAnalysis returns miss_no_trigger', async () => {
        mockedRun.mockResolvedValue({ status: 'miss_no_trigger' } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'skipped' });
    });

    it('returns error when runAnalysis throws (LLM failure)', async () => {
        mockedRun.mockRejectedValue(new Error('Network failure'));

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'Error: Network failure' });
    });

    it('returns error when runAnalysis returns error status (tier gate)', async () => {
        mockedRun.mockResolvedValue({
            status: 'error',
            error: { message: 'Timeframe not allowed', code: 'timeframe_not_allowed' },
        } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result.status).toBe('error');
        // toErrStr은 object-with-message에서 .message를 추출한다(B3).
        expect(result.error).toContain('Timeframe not allowed');
    });

    it('returns error when runAnalysis returns key_error (BYOK required)', async () => {
        mockedRun.mockResolvedValue({
            status: 'key_error',
            code: 'user_api_key_required',
            error: 'BYOK API key required for this model',
            modelId: 'claude-sonnet-4-20250514',
            tier: 'pro',
        } as any);

        const result = await runTechnicalAnalysis(baseOptions);

        expect(result).toEqual({ status: 'error', error: 'BYOK API key required for this model' });
    });

    it('passes correct arguments to runAnalysis', async () => {
        mockedRun.mockResolvedValue({ status: 'cached', result: {}, lockedInfoDepth: [] } as any);

        await runTechnicalAnalysis({ ...baseOptions, userApiKey: 'sk-123' });

        // 4번째 인자 `force = true` — core 캐시를 우회한다. 캐시 TTL(1Hour)이 케이던스
        // 창과 같아, 캐시를 쓰면 신규 분석이 2시간에 한 번이 되고 execute가
        // `source_analyzed_at` 기준으로 `stale_analysis` 처리해 청산 평가가 멈춘다.
        expect(mockedRun).toHaveBeenCalledWith('AAPL', 'Apple Inc.', '1Hour', true, undefined, {
            modelId: baseOptions.modelId,
            userApiKey: 'sk-123',
            marketDataProvider: mockProvider,
            tierContext: { userId: null, tier: 'pro' },
            reasoning: true,
            // B2: 심볼 단위 AbortSignal이 전달되어야 한다.
            signal: expect.any(AbortSignal),
        });
    });
});
