import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../execute';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyCronSecret = vi.fn<(req: Request) => boolean>();
vi.mock('../../_lib/cron-auth', () => ({
    verifyCronSecret: (...args: [Request]) => mockVerifyCronSecret(...args),
}));

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

const mockGetEnabledWatchlist = vi.fn();
const mockGetConfigValue = vi.fn();
const mockGetAnalysisConfig = vi.fn();
const mockGetLatestAnalysisResult = vi.fn();
const mockGetOpenPositions = vi.fn();
const mockGetOpenPositionBySymbol = vi.fn();
const mockClosePosition = vi.fn();
const mockSaveAnalysisResult = vi.fn();
const mockInsertTrade = vi.fn();
const mockInsertPendingOrder = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getEnabledWatchlist: (...args: unknown[]) => mockGetEnabledWatchlist(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    getAnalysisConfig: (...args: unknown[]) => mockGetAnalysisConfig(...args),
    getLatestAnalysisResult: (...args: unknown[]) => mockGetLatestAnalysisResult(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getOpenPositionBySymbol: (...args: unknown[]) => mockGetOpenPositionBySymbol(...args),
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    saveAnalysisResult: (...args: unknown[]) => mockSaveAnalysisResult(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    insertPendingOrder: (...args: unknown[]) => mockInsertPendingOrder(...args),
}));

const mockRunOverallAnalysis = vi.fn();
vi.mock('../../../lib/analysis/run-overall', () => ({
    runOverallAnalysis: (...args: unknown[]) => mockRunOverallAnalysis(...args),
}));

const mockScoreSignals = vi.fn();
vi.mock('../../../lib/strategy/signal-scorer', () => ({
    scoreSignals: (...args: unknown[]) => mockScoreSignals(...args),
}));

const mockCalculatePositionSize = vi.fn();
const mockEvaluateExistingPosition = vi.fn();
vi.mock('../../../lib/strategy/risk-manager', () => ({
    calculatePositionSize: (...args: unknown[]) => mockCalculatePositionSize(...args),
    evaluateExistingPosition: (...args: unknown[]) => mockEvaluateExistingPosition(...args),
}));

const mockMakeTradeDecision = vi.fn();
vi.mock('../../../lib/strategy/decision', () => ({
    makeTradeDecision: (...args: unknown[]) => mockMakeTradeDecision(...args),
}));

const mockExecuteBuyOrder = vi.fn();
const mockExecuteSellOrder = vi.fn();
vi.mock('../../../lib/trading/order', () => ({
    executeBuyOrder: (...args: unknown[]) => mockExecuteBuyOrder(...args),
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockSendTradeExecutedEmail = vi.fn();
const mockSendApprovalRequestEmail = vi.fn();
const mockSendErrorEmail = vi.fn();
vi.mock('../../../lib/notification/email', () => ({
    sendTradeExecutedEmail: (...args: unknown[]) => mockSendTradeExecutedEmail(...args),
    sendApprovalRequestEmail: (...args: unknown[]) => mockSendApprovalRequestEmail(...args),
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
}));

vi.mock('../_run-analysis-cron', () => ({
    resolveApiKey: (modelId: string) => {
        if (modelId.startsWith('claude')) return 'sk-ant-test';
        if (modelId.startsWith('gpt')) return 'sk-openai-test';
        return undefined;
    },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = { fake: 'db' };
const fakeWatchlist = [
    { symbol: 'AAPL', companyName: 'Apple Inc.', enabled: true },
    { symbol: 'TSLA', companyName: 'Tesla Inc.', enabled: true },
];

const fakeTechResult = {
    result: { trend: 'bullish', riskLevel: 'low', keyLevels: { currentPrice: 150 } },
};
const fakeNewsResult = { result: { overallSentiment: 'bullish' } };
const fakeOptionsResult = { result: { signals: [{ type: 'bullish' }] } };
const fakeFundamentalResult = { result: { overallSentiment: 'neutral' } };

const fakeBuySignalScore = {
    total: 80,
    components: { technical: 95, news: 80, options: 75, fundamental: 50, overall: 50 },
    signal: 'buy' as const,
};

const fakeSellSignalScore = {
    total: 20,
    components: { technical: 15, news: 20, options: 25, fundamental: 50, overall: 50 },
    signal: 'sell' as const,
};

const fakeHoldSignalScore = {
    total: 50,
    components: { technical: 50, news: 50, options: 50, fundamental: 50, overall: 50 },
    signal: 'hold' as const,
};

function makeRequest(authorized: boolean): Request {
    const headers = new Headers();
    if (authorized) {
        headers.set('authorization', 'Bearer test-secret');
    }
    return new Request('https://example.com/api/cron/execute', { headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults() {
    mockGetDb.mockReturnValue(fakeDb);
    mockVerifyCronSecret.mockReturnValue(true);
    mockGetConfigValue.mockResolvedValue(null); // All config values default to null
    mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
    mockGetOpenPositions.mockResolvedValue([]);
    mockGetAnalysisConfig.mockResolvedValue(null); // Overall disabled by default
    mockGetLatestAnalysisResult.mockResolvedValue(null);
    mockGetOpenPositionBySymbol.mockResolvedValue(null);
    mockClosePosition.mockResolvedValue([]);
    mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
    mockCalculatePositionSize.mockReturnValue(5);
    mockEvaluateExistingPosition.mockReturnValue({ action: 'hold', reason: '유지 (조건 미충족)' });
    mockMakeTradeDecision.mockReturnValue({
        action: 'hold',
        symbol: 'AAPL',
        score: 50,
        reason: 'Score 50/100 — HOLD',
        quantity: 0,
    });
    mockInsertTrade.mockResolvedValue([]);
    mockInsertPendingOrder.mockResolvedValue([]);
    mockSaveAnalysisResult.mockResolvedValue([]);
    mockSendTradeExecutedEmail.mockResolvedValue(undefined);
    mockSendApprovalRequestEmail.mockResolvedValue(undefined);
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockExecuteBuyOrder.mockResolvedValue({ orderId: 'ord-1', status: 'filled', filledPrice: 150 });
    mockExecuteSellOrder.mockResolvedValue({
        orderId: 'ord-2',
        status: 'filled',
        filledPrice: 148,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute cron handler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T14:30:00.000Z'));
        setupDefaults();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------

    describe('auth', () => {
        it('returns 401 when cron secret is invalid', async () => {
            mockVerifyCronSecret.mockReturnValue(false);

            const res = await handler(makeRequest(false));

            expect(res.status).toBe(401);
            expect(await res.text()).toBe('Unauthorized');
            expect(mockGetConfigValue).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Config loading
    // -----------------------------------------------------------------------

    describe('config loading', () => {
        it('uses default values when config not set in DB', async () => {
            mockGetConfigValue.mockResolvedValue(null);
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should succeed with defaults (dry_run mode)
            expect(body.tradingMode).toBe('dry_run');
            expect(mockInsertTrade).toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Empty watchlist
    // -----------------------------------------------------------------------

    describe('empty watchlist', () => {
        it('returns skipped response when watchlist is empty and no open positions', async () => {
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions.mockResolvedValue([]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
        });
    });

    // -----------------------------------------------------------------------
    // DRY_RUN mode
    // -----------------------------------------------------------------------

    describe('dry_run mode', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult);
                    if (type === 'news') return Promise.resolve(fakeNewsResult);
                    if (type === 'options') return Promise.resolve(fakeOptionsResult);
                    if (type === 'fundamental') return Promise.resolve(fakeFundamentalResult);
                    return Promise.resolve(null);
                },
            );
        });

        it('inserts trade to DB but does NOT call executeBuyOrder/executeSellOrder', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.tradingMode).toBe('dry_run');
            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'buy', score: 80 }]);

            // Trade inserted
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    orderType: 'market',
                    quantity: 5,
                    price: 150,
                    mode: 'dry_run',
                }),
            );

            // Toss API never called
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        });

        it('does NOT send email notifications in dry_run mode', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();
            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // SEMI_AUTO mode
    // -----------------------------------------------------------------------

    describe('semi_auto mode', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('semi_auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult);
                    return Promise.resolve(null);
                },
            );
        });

        it('inserts pending order and sends approval email', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockInsertPendingOrder).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    priceLimit: 150,
                    analysisSummary: 'Score 80/100 — BUY',
                    signalScore: 80,
                }),
            );

            expect(mockSendApprovalRequestEmail).toHaveBeenCalledWith({
                symbol: 'AAPL',
                side: 'buy',
                quantity: 5,
                score: 80,
                reason: 'Score 80/100 — BUY',
                approveUrl: 'https://auto-trade.siglens.io/pending',
            });
        });

        it('does NOT call executeBuyOrder/executeSellOrder', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // AUTO mode
    // -----------------------------------------------------------------------

    describe('auto mode', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult);
                    return Promise.resolve(null);
                },
            );
        });

        it('calls executeBuyOrder for buy decisions', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockExecuteBuyOrder).toHaveBeenCalledWith('AAPL', 5);
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        });

        it('calls executeSellOrder for sell decisions', async () => {
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });
            mockScoreSignals.mockReturnValue(fakeSellSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'sell',
                symbol: 'AAPL',
                score: 20,
                reason: 'Score 20/100 — SELL',
                quantity: 10,
            });

            await handler(makeRequest(true));

            expect(mockExecuteSellOrder).toHaveBeenCalledWith('AAPL', 10);
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
        });

        it('inserts trade record with filled price from order result', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                filledPrice: 151.5,
            });

            await handler(makeRequest(true));

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    price: 151.5,
                    mode: 'auto',
                }),
            );
        });

        it('sends trade executed email after successful order', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                filledPrice: 151.5,
            });

            await handler(makeRequest(true));

            expect(mockSendTradeExecutedEmail).toHaveBeenCalledWith({
                symbol: 'AAPL',
                side: 'buy',
                quantity: 5,
                price: 151.5,
                reason: 'Score 80/100 — BUY',
                mode: 'auto',
            });
        });

        it('uses currentPrice when filledPrice is undefined', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                filledPrice: undefined,
            });

            await handler(makeRequest(true));

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    price: 150, // fallback to currentPrice
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Signal scoring & decisions
    // -----------------------------------------------------------------------

    describe('signal scoring & decisions', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
        });

        it('HOLD decision: no trade inserted, no order', async () => {
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'Score 50/100 — HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'hold', score: 50 }]);
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockInsertPendingOrder).not.toHaveBeenCalled();
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        });

        it('BUY decision in dry_run: inserts trade', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'buy', score: 80 }]);
            expect(mockInsertTrade).toHaveBeenCalledTimes(1);
        });

        it('SELL decision requires existing position', async () => {
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });
            mockScoreSignals.mockReturnValue(fakeSellSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'sell',
                symbol: 'AAPL',
                score: 20,
                reason: 'Score 20/100 — SELL',
                quantity: 10,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'sell', score: 20 }]);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    side: 'sell',
                    quantity: 10,
                }),
            );
        });

        it('passes correct inputs to scoreSignals', async () => {
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult);
                    if (type === 'news') return Promise.resolve(fakeNewsResult);
                    if (type === 'options') return Promise.resolve(fakeOptionsResult);
                    if (type === 'fundamental') return Promise.resolve(fakeFundamentalResult);
                    return Promise.resolve(null);
                },
            );

            await handler(makeRequest(true));

            expect(mockScoreSignals).toHaveBeenCalledWith(
                {
                    technical: fakeTechResult.result,
                    news: fakeNewsResult.result,
                    options: fakeOptionsResult.result,
                    fundamental: fakeFundamentalResult.result,
                    overall: null,
                },
                expect.any(Object), // weights
                expect.any(Number), // buyThreshold
                expect.any(Number), // sellThreshold
            );
        });

        it('passes existingPosition context to makeTradeDecision', async () => {
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            await handler(makeRequest(true));

            expect(mockMakeTradeDecision).toHaveBeenCalledWith(
                expect.objectContaining({
                    hasOpenPosition: true,
                    positionQuantity: 10,
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------

    describe('error handling', () => {
        it('catches exception during analysis and sends error email, continues to next symbol', async () => {
            mockGetConfigValue.mockResolvedValue(null);
            mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
            mockGetLatestAnalysisResult.mockRejectedValueOnce(new Error('DB timeout'));
            // Second symbol succeeds
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'TSLA',
                score: 50,
                reason: 'Score 50/100 — HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toHaveLength(2);
            expect(body.decisions[0]).toEqual({ symbol: 'AAPL', action: 'error', score: 0 });
            expect(body.decisions[1]).toEqual({ symbol: 'TSLA', action: 'hold', score: 50 });

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                'AAPL',
                expect.stringContaining('DB timeout'),
            );
        });

        it('error email failure does not crash the handler', async () => {
            mockGetConfigValue.mockResolvedValue(null);
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockRejectedValue(new Error('Something broke'));
            mockSendErrorEmail.mockRejectedValue(new Error('Email service down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'error', score: 0 }]);
        });
    });

    // -----------------------------------------------------------------------
    // Overall analysis
    // -----------------------------------------------------------------------

    describe('overall analysis', () => {
        beforeEach(() => {
            mockGetConfigValue.mockResolvedValue(null);
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'Score 50/100 — HOLD',
                quantity: 0,
            });
        });

        it('runs runOverallAnalysis and saves result when overall config is enabled', async () => {
            mockGetAnalysisConfig.mockResolvedValue({
                enabled: true,
                modelId: 'claude-sonnet-4-20250514',
                useByok: true,
            });
            const fakeOverallResult = { integratedConclusionKo: '매수 추천' };
            mockRunOverallAnalysis.mockResolvedValue({
                status: 'done',
                result: fakeOverallResult,
            });

            await handler(makeRequest(true));

            expect(mockRunOverallAnalysis).toHaveBeenCalledWith({
                symbol: 'AAPL',
                companyName: 'Apple Inc.',
                modelId: 'claude-sonnet-4-20250514',
                userApiKey: 'sk-ant-test',
            });

            expect(mockSaveAnalysisResult).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    analysisType: 'overall',
                    result: fakeOverallResult,
                    modelId: 'claude-sonnet-4-20250514',
                }),
            );

            // Score signals should receive the overall result
            expect(mockScoreSignals).toHaveBeenCalledWith(
                expect.objectContaining({ overall: fakeOverallResult }),
                expect.any(Object),
                expect.any(Number),
                expect.any(Number),
            );
        });

        it('skips overall analysis when config is disabled (null)', async () => {
            mockGetAnalysisConfig.mockResolvedValue(null);

            await handler(makeRequest(true));

            expect(mockRunOverallAnalysis).not.toHaveBeenCalled();
            expect(mockScoreSignals).toHaveBeenCalledWith(
                expect.objectContaining({ overall: null }),
                expect.any(Object),
                expect.any(Number),
                expect.any(Number),
            );
        });

        it('skips overall when overallConfig.enabled is false', async () => {
            mockGetAnalysisConfig.mockResolvedValue({
                enabled: false,
                modelId: 'claude-sonnet-4-20250514',
            });

            await handler(makeRequest(true));

            expect(mockRunOverallAnalysis).not.toHaveBeenCalled();
        });

        it('uses cached overall result', async () => {
            mockGetAnalysisConfig.mockResolvedValue({
                enabled: true,
                modelId: 'claude-sonnet-4-20250514',
                useByok: false,
            });
            const cachedResult = { integratedConclusionKo: '캐시됨' };
            mockRunOverallAnalysis.mockResolvedValue({
                status: 'cached',
                result: cachedResult,
            });

            await handler(makeRequest(true));

            expect(mockSaveAnalysisResult).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    result: cachedResult,
                }),
            );
            expect(mockScoreSignals).toHaveBeenCalledWith(
                expect.objectContaining({ overall: cachedResult }),
                expect.any(Object),
                expect.any(Number),
                expect.any(Number),
            );
        });

        it('does not save overall result when analysis returns error/skipped', async () => {
            mockGetAnalysisConfig.mockResolvedValue({
                enabled: true,
                modelId: 'claude-sonnet-4-20250514',
                useByok: true,
            });
            mockRunOverallAnalysis.mockResolvedValue({
                status: 'error',
                error: 'API failed',
            });

            await handler(makeRequest(true));

            expect(mockSaveAnalysisResult).not.toHaveBeenCalled();
            expect(mockScoreSignals).toHaveBeenCalledWith(
                expect.objectContaining({ overall: null }),
                expect.any(Object),
                expect.any(Number),
                expect.any(Number),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Exposure calculation
    // -----------------------------------------------------------------------

    describe('exposure calculation', () => {
        it('calculates currentExposure from open positions', async () => {
            mockGetConfigValue.mockResolvedValue(null);
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'MSFT', quantity: 5, avgPrice: '300', status: 'open' },
                { symbol: 'GOOG', quantity: 2, avgPrice: '150', status: 'open' },
            ]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'BUY',
                quantity: 3,
            });

            await handler(makeRequest(true));

            // currentExposure = 5*300 + 2*150 = 1800
            expect(mockCalculatePositionSize).toHaveBeenCalledWith(
                expect.objectContaining({
                    currentExposure: 1800,
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Response format
    // -----------------------------------------------------------------------

    describe('response format', () => {
        it('returns cronRunId, tradingMode, and decisions array', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.cronRunId).toMatch(/^exec-\d+$/);
            expect(body.tradingMode).toBe('dry_run');
            expect(body.decisions).toBeInstanceOf(Array);
        });
    });

    // -----------------------------------------------------------------------
    // Position re-evaluation
    // -----------------------------------------------------------------------

    describe('position re-evaluation', () => {
        const fakeOpenPosition = {
            id: 1,
            symbol: 'AAPL',
            quantity: 10,
            avgPrice: '100',
            status: 'open',
        };

        const fakeTechWithBearish = {
            result: {
                trend: 'bearish',
                riskLevel: 'high',
                keyLevels: { currentPrice: 95, support: [90], resistance: [110] },
                priceTargets: { bullish: { target: 120 } },
            },
        };

        const fakeTechWithSupport = {
            result: {
                trend: 'neutral',
                riskLevel: 'medium',
                keyLevels: { currentPrice: 88, support: [90], resistance: [110] },
            },
        };

        const fakeTechAtTarget = {
            result: {
                trend: 'bullish',
                riskLevel: 'low',
                keyLevels: { currentPrice: 115, support: [100], resistance: [120] },
                priceTargets: { bullish: { target: 116 } },
            },
        };

        const fakeTechHealthy = {
            result: {
                trend: 'bullish',
                riskLevel: 'low',
                keyLevels: { currentPrice: 105, support: [95], resistance: [120] },
                priceTargets: { bullish: { target: 130 } },
            },
        };

        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            // Empty watchlist to isolate position re-evaluation from new-entry loop
            mockGetEnabledWatchlist.mockResolvedValue([]);
        });

        it('sells position in dry_run when trend is bearish', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전 (bearish)',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockEvaluateExistingPosition).toHaveBeenCalledWith(
                expect.objectContaining({
                    avgPrice: 100,
                    currentPrice: 95,
                    technicalTrend: 'bearish',
                }),
            );
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 10,
                    price: 95,
                    mode: 'dry_run',
                    reason: '기술적 추세 반전 (bearish)',
                }),
            );
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 95);
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stop_loss',
                score: 0,
            });
        });

        it('sells position when price is below support', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithSupport);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '지지선 이탈 (지지: $90, 현재: $88)',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    price: 88,
                }),
            );
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 88);
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stop_loss',
                score: 0,
            });
        });

        it('takes profit when price is near target', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechAtTarget);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'take_profit',
                reason: '목표가 근접 (목표: $116)',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    price: 115,
                }),
            );
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 115);
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'take_profit',
                score: 0,
            });
        });

        it('takes no action when position is healthy', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechHealthy);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'hold',
                reason: '유지 (조건 미충족)',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // No trade or position close
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            // No decisions pushed for hold
            expect(body.decisions).toEqual([]);
        });

        it('skips position when no currentPrice available', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockResolvedValue({ result: {} }); // no keyLevels

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockEvaluateExistingPosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(body.decisions).toEqual([]);
        });

        it('handles semi_auto mode for position re-evaluation', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('semi_auto');
                return Promise.resolve(null);
            });
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전 (bearish)',
            });

            await handler(makeRequest(true));

            expect(mockInsertPendingOrder).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 10,
                }),
            );
            expect(mockSendApprovalRequestEmail).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                }),
            );
            // No direct close in semi_auto
            expect(mockClosePosition).not.toHaveBeenCalled();
        });

        it('handles auto mode for position re-evaluation', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전 (bearish)',
            });

            await handler(makeRequest(true));

            expect(mockExecuteSellOrder).toHaveBeenCalledWith('AAPL', 10);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    mode: 'auto',
                }),
            );
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 148); // filledPrice from mock
            expect(mockSendTradeExecutedEmail).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    mode: 'auto',
                }),
            );
        });

        it('catches errors during re-evaluation and continues', async () => {
            mockGetOpenPositions.mockResolvedValue([
                fakeOpenPosition,
                { ...fakeOpenPosition, id: 2, symbol: 'TSLA' },
            ]);
            // First position throws
            mockGetLatestAnalysisResult
                .mockRejectedValueOnce(new Error('DB error'))
                .mockRejectedValueOnce(new Error('DB error'))
                // Second position succeeds
                .mockImplementation((_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechHealthy);
                    return Promise.resolve(null);
                });
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'hold',
                reason: '유지 (조건 미충족)',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                'AAPL',
                expect.stringContaining('DB error'),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'error',
                score: 0,
            });
        });
    });
});
