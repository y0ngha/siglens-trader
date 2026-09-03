import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunAnalysisOptions, PriorAnalysisRow } from '../types';

const mockAnalysisHistoryQuery = vi.fn();
vi.mock('@y0ngha/siglens-core', () => ({
    runAnalysis: vi.fn(),
    analysisHistoryQuery: (...args: unknown[]) => mockAnalysisHistoryQuery(...args),
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

    it('마감이 있으면 그 시각까지를 예산으로 하는 signal을 넘긴다', async () => {
        mockedRun.mockResolvedValue({ status: 'cached', result: {}, lockedInfoDepth: [] } as any);

        await runTechnicalAnalysis({ ...baseOptions, deadlineMs: Date.now() + 600_000 });

        expect(mockedRun.mock.calls[0]![5]!.signal).toBeInstanceOf(AbortSignal);
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
            // 마감이 없는 호출(baseOptions)은 signal도 없다 — 심볼당 상한을 두지 않는다.
            // 종전 150초 상한은 추론 ON 축에서 타임아웃이 아니라 실패 그 자체였다.
            signal: undefined,
            // priorAnalysisStore를 안 넘긴 호출(baseOptions)은 priorAnalyses도 생략한다.
            priorAnalyses: undefined,
        });
    });
});

describe('runTechnicalAnalysis — priorAnalyses', () => {
    const validRow: PriorAnalysisRow = {
        result: {
            trend: 'bullish',
            riskLevel: 'medium',
            actionRecommendation: {
                entryPrices: [148, 152],
                stopLoss: 140,
                takeProfitPrices: [170, 185],
            },
        },
        analyzedAt: new Date('2026-05-24T08:00:00.000Z'),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockedRun.mockResolvedValue({ status: 'cached', result: {}, lockedInfoDepth: [] } as any);
        mockAnalysisHistoryQuery.mockReturnValue({ limit: 21, sinceMs: 3_600_000 });
    });

    it('store가 없으면 조회 없이 priorAnalyses를 생략한다', async () => {
        await runTechnicalAnalysis(baseOptions);

        expect(mockAnalysisHistoryQuery).not.toHaveBeenCalled();
        expect(mockedRun.mock.calls[0]![5]!.priorAnalyses).toBeUndefined();
    });

    it('core의 analysisHistoryQuery로 크기를 정하고 store.getRecent에 넘긴다', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T10:00:00.000Z'));
        const getRecent = vi.fn().mockResolvedValue([validRow]);

        await runTechnicalAnalysis({
            ...baseOptions,
            timeframe: '30Min',
            priorAnalysisStore: { getRecent },
        });

        expect(mockAnalysisHistoryQuery).toHaveBeenCalledWith('30Min');
        expect(getRecent).toHaveBeenCalledWith({
            symbol: 'AAPL',
            timeframe: '30Min',
            limit: 21,
            since: new Date('2026-05-24T09:00:00.000Z'), // now - sinceMs(3_600_000)
        });
        vi.useRealTimers();
    });

    it('유효한 행을 core의 PriorAnalysis로 매핑해 넘긴다', async () => {
        const getRecent = vi.fn().mockResolvedValue([validRow]);

        await runTechnicalAnalysis({ ...baseOptions, priorAnalysisStore: { getRecent } });

        expect(mockedRun.mock.calls[0]![5]!.priorAnalyses).toEqual([
            {
                generatedAt: validRow.analyzedAt,
                trend: 'bullish',
                riskLevel: 'medium',
                entryPrices: [148, 152],
                stopLoss: 140,
                takeProfitPrices: [170, 185],
            },
        ]);
    });

    it('매핑 결과가 빈 배열이면 priorAnalyses를 생략한다(유효한 행이 하나도 없을 때)', async () => {
        const getRecent = vi
            .fn()
            .mockResolvedValue([{ result: { riskLevel: 'medium' }, analyzedAt: new Date() }]);

        await runTechnicalAnalysis({ ...baseOptions, priorAnalysisStore: { getRecent } });

        expect(mockedRun.mock.calls[0]![5]!.priorAnalyses).toBeUndefined();
    });

    it('store.getRecent이 실패해도 분석은 이력 없이 진행한다', async () => {
        const getRecent = vi.fn().mockRejectedValue(new Error('DB down'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await runTechnicalAnalysis({
            ...baseOptions,
            priorAnalysisStore: { getRecent },
        });

        expect(result.status).toBe('cached');
        expect(mockedRun.mock.calls[0]![5]!.priorAnalyses).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
