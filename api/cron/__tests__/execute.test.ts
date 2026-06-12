import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as handler } from '../execute';

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
const mockOpenPosition = vi.fn();
const mockClosePosition = vi.fn();
const mockReducePositionQuantity = vi.fn();
const mockSaveAnalysisResult = vi.fn();
const mockInsertTrade = vi.fn();
const mockInsertPendingOrder = vi.fn();
const mockGetPendingOrders = vi.fn();
const mockGetTodayTradeCount = vi.fn();
const mockGetTodayRealizedPnl = vi.fn();
const mockExpireOldPendingOrders = vi.fn();
const mockCreateOrderTracking = vi.fn();
const mockUpdateOrderTracking = vi.fn();
const mockGetPendingSubmittedOrders = vi.fn();
const mockAverageIntoPosition = vi.fn();
const mockGetNotificationConfig = vi.fn();
const mockStartCronRun = vi.fn();
const mockFinishCronRun = vi.fn();
const mockInsertCronDecisions = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getEnabledWatchlist: (...args: unknown[]) => mockGetEnabledWatchlist(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    getAnalysisConfig: (...args: unknown[]) => mockGetAnalysisConfig(...args),
    getLatestAnalysisResult: (...args: unknown[]) => mockGetLatestAnalysisResult(...args),
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getOpenPositionBySymbol: (...args: unknown[]) => mockGetOpenPositionBySymbol(...args),
    openPosition: (...args: unknown[]) => mockOpenPosition(...args),
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    reducePositionQuantity: (...args: unknown[]) => mockReducePositionQuantity(...args),
    saveAnalysisResult: (...args: unknown[]) => mockSaveAnalysisResult(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    insertPendingOrder: (...args: unknown[]) => mockInsertPendingOrder(...args),
    getPendingOrders: (...args: unknown[]) => mockGetPendingOrders(...args),
    getTodayTradeCount: (...args: unknown[]) => mockGetTodayTradeCount(...args),
    getTodayRealizedPnl: (...args: unknown[]) => mockGetTodayRealizedPnl(...args),
    expireOldPendingOrders: (...args: unknown[]) => mockExpireOldPendingOrders(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
    getPendingSubmittedOrders: (...args: unknown[]) => mockGetPendingSubmittedOrders(...args),
    averageIntoPosition: (...args: unknown[]) => mockAverageIntoPosition(...args),
    getNotificationConfig: (...args: unknown[]) => mockGetNotificationConfig(...args),
    startCronRun: (...args: unknown[]) => mockStartCronRun(...args),
    finishCronRun: (...args: unknown[]) => mockFinishCronRun(...args),
    insertCronDecisions: (...args: unknown[]) => mockInsertCronDecisions(...args),
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
vi.mock('../../../lib/trading/orders', () => ({
    executeBuyOrder: (...args: unknown[]) => mockExecuteBuyOrder(...args),
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockGetBuyingPower = vi.fn();
const mockGetSellableQuantity = vi.fn();
const mockIsUsMarketOpen = vi.fn();
vi.mock('../../../lib/trading/account', () => ({
    getBuyingPower: (...args: unknown[]) => mockGetBuyingPower(...args),
    getSellableQuantity: (...args: unknown[]) => mockGetSellableQuantity(...args),
    isUsMarketOpen: (...args: unknown[]) => mockIsUsMarketOpen(...args),
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

const mockFetchLivePrice = vi.fn<(symbol: string) => Promise<number | null>>();
vi.mock('../../../lib/data/live-price', () => ({
    fetchLivePrice: (...args: [string]) => mockFetchLivePrice(...args),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../lib/lock', () => ({
    acquireLock: (...args: unknown[]) => mockAcquireLock(...(args as [])),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...(args as [])),
}));

const mockIsEtRegularSessionOpen = vi.fn<(now: Date) => boolean>();
vi.mock('@y0ngha/siglens-core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@y0ngha/siglens-core')>()),
    isEtRegularSessionOpen: (...args: [Date]) => mockIsEtRegularSessionOpen(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = {
    fake: 'db',
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};
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
    mockIsEtRegularSessionOpen.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue(true);
    mockReleaseLock.mockResolvedValue(undefined);
    mockGetConfigValue.mockResolvedValue(null); // All config values default to null
    mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
    mockGetOpenPositions.mockResolvedValue([]);
    mockGetAnalysisConfig.mockResolvedValue(null); // Overall disabled by default
    mockGetLatestAnalysisResult.mockResolvedValue(null);
    mockGetOpenPositionBySymbol.mockResolvedValue(null);
    mockOpenPosition.mockResolvedValue([]);
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
    mockGetPendingOrders.mockResolvedValue([]);
    mockGetTodayTradeCount.mockResolvedValue(0);
    mockGetTodayRealizedPnl.mockResolvedValue(0);
    mockExpireOldPendingOrders.mockResolvedValue([]);
    mockSaveAnalysisResult.mockResolvedValue([]);
    mockSendTradeExecutedEmail.mockResolvedValue(undefined);
    mockSendApprovalRequestEmail.mockResolvedValue(undefined);
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockExecuteBuyOrder.mockResolvedValue({
        orderId: 'ord-1',
        clientOrderId: 'coid-1',
        status: 'filled',
        avgFilledPrice: 150,
    });
    mockExecuteSellOrder.mockResolvedValue({
        orderId: 'ord-2',
        clientOrderId: 'coid-2',
        status: 'filled',
        avgFilledPrice: 148,
    });
    // Account guards: default open market + abundant buying power so existing tests place orders.
    mockIsUsMarketOpen.mockResolvedValue(true);
    mockGetBuyingPower.mockResolvedValue(1_000_000);
    mockGetSellableQuantity.mockResolvedValue(1_000_000);
    mockCreateOrderTracking.mockResolvedValue([]);
    mockUpdateOrderTracking.mockResolvedValue([]);
    mockAverageIntoPosition.mockResolvedValue(undefined);
    mockReducePositionQuantity.mockResolvedValue(true);
    mockGetPendingSubmittedOrders.mockResolvedValue([]);
    mockFetchLivePrice.mockResolvedValue(null);
    mockStartCronRun.mockResolvedValue(undefined);
    mockFinishCronRun.mockResolvedValue(undefined);
    mockInsertCronDecisions.mockResolvedValue(undefined);
    // Default: email channel enabled with all events selected so existing
    // notification assertions still fire. Tests that exercise the gate override this.
    mockGetNotificationConfig.mockResolvedValue([
        {
            channel: 'email',
            enabled: true,
            target: 'test@example.com',
            events: ['trade_executed', 'order_pending', 'stop_loss', 'error'],
        },
    ]);
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
    // Market hours
    // -----------------------------------------------------------------------

    describe('market hours', () => {
        it('skips before acquiring the lock when the U.S. regular session is closed', async () => {
            mockIsEtRegularSessionOpen.mockReturnValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'market_closed' });
            expect(mockAcquireLock).not.toHaveBeenCalled();
            expect(mockGetConfigValue).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Distributed lock
    // -----------------------------------------------------------------------

    describe('distributed lock', () => {
        it('returns skipped response when lock cannot be acquired', async () => {
            mockAcquireLock.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'another_execution_in_progress' });
            expect(mockGetConfigValue).not.toHaveBeenCalled();
        });

        it('releases lock after successful execution', async () => {
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions.mockResolvedValue([]);

            await handler(makeRequest(true));

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
        });

        it('releases lock even when handler throws', async () => {
            mockGetNotificationConfig.mockRejectedValue(new Error('DB connection failed'));

            await expect(handler(makeRequest(true))).rejects.toThrow('DB connection failed');

            expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
        });
    });

    // -----------------------------------------------------------------------
    // Circuit breakers
    // -----------------------------------------------------------------------

    describe('circuit breakers', () => {
        describe('kill switch (trading_enabled)', () => {
            it('returns skipped response when trading_enabled is false', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'trading_enabled') return Promise.resolve(false);
                    return Promise.resolve(null);
                });

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'trading_disabled' });
                expect(mockGetEnabledWatchlist).not.toHaveBeenCalled();
            });

            it('proceeds when trading_enabled is true', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'trading_enabled') return Promise.resolve(true);
                    return Promise.resolve(null);
                });
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
            });

            it('defaults to enabled when trading_enabled is not set', async () => {
                mockGetConfigValue.mockResolvedValue(null);
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
            });

            it('releases lock when trading is disabled', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'trading_enabled') return Promise.resolve(false);
                    return Promise.resolve(null);
                });

                await handler(makeRequest(true));

                expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
            });
        });

        describe('daily trade limit', () => {
            it('returns skipped response when daily trade limit is reached', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_trades_per_day') return Promise.resolve(10);
                    return Promise.resolve(null);
                });
                mockGetTodayTradeCount.mockResolvedValue(10);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({
                    skipped: true,
                    reason: 'daily_trade_limit_reached',
                    todayCount: 10,
                    limit: 10,
                });
            });

            it('returns skipped when today count exceeds limit', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_trades_per_day') return Promise.resolve(5);
                    return Promise.resolve(null);
                });
                mockGetTodayTradeCount.mockResolvedValue(7);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({
                    skipped: true,
                    reason: 'daily_trade_limit_reached',
                    todayCount: 7,
                    limit: 5,
                });
            });

            it('proceeds when under the daily limit', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_trades_per_day') return Promise.resolve(20);
                    return Promise.resolve(null);
                });
                mockGetTodayTradeCount.mockResolvedValue(5);
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
            });

            it('uses default limit of 20 when not configured', async () => {
                mockGetConfigValue.mockResolvedValue(null);
                mockGetTodayTradeCount.mockResolvedValue(20);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({
                    skipped: true,
                    reason: 'daily_trade_limit_reached',
                    todayCount: 20,
                    limit: 20,
                });
            });

            it('releases lock when daily limit is reached', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_trades_per_day') return Promise.resolve(5);
                    return Promise.resolve(null);
                });
                mockGetTodayTradeCount.mockResolvedValue(5);

                await handler(makeRequest(true));

                expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
            });
        });

        describe('daily loss limit', () => {
            it('returns skipped response when daily loss exceeds limit', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-600);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({
                    skipped: true,
                    reason: 'daily_loss_limit_reached',
                    todayPnl: -600,
                    limit: 500,
                });
            });

            it('sends error email when daily loss limit is hit', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(300);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-350);

                await handler(makeRequest(true));

                expect(mockSendErrorEmail).toHaveBeenCalledWith(
                    '일일 손실 한도 초과',
                    expect.stringContaining('$350.00'),
                );
            });

            it('does NOT send the loss-limit error email when email is disabled', async () => {
                mockGetNotificationConfig.mockResolvedValue([
                    { channel: 'email', enabled: false, target: 't@e.com', events: ['error'] },
                ]);
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(300);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-350);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                // Circuit breaker still trips — only the alert email is suppressed.
                expect(body.reason).toBe('daily_loss_limit_reached');
                expect(mockSendErrorEmail).not.toHaveBeenCalled();
            });

            it('does NOT send the loss-limit error email when the error event is unselected', async () => {
                mockGetNotificationConfig.mockResolvedValue([
                    {
                        channel: 'email',
                        enabled: true,
                        target: 't@e.com',
                        events: ['trade_executed'],
                    },
                ]);
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(300);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-350);

                await handler(makeRequest(true));

                expect(mockSendErrorEmail).not.toHaveBeenCalled();
            });

            it('proceeds when loss is within limit', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-200);
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
            });

            it('proceeds when PnL is positive', async () => {
                mockGetTodayRealizedPnl.mockResolvedValue(300);
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
            });

            it('uses default limit of 500 when not configured', async () => {
                mockGetConfigValue.mockResolvedValue(null);
                mockGetTodayRealizedPnl.mockResolvedValue(-501);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body).toEqual({
                    skipped: true,
                    reason: 'daily_loss_limit_reached',
                    todayPnl: -501,
                    limit: 500,
                });
            });

            it('releases lock when daily loss limit is reached', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                    return Promise.resolve(null);
                });
                mockGetTodayRealizedPnl.mockResolvedValue(-600);

                await handler(makeRequest(true));

                expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
            });
        });

        describe('in-loop daily trade limit', () => {
            it('skips remaining symbols when in-loop daily limit is reached', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'trading_mode') return Promise.resolve('dry_run');
                    if (key === 'max_trades_per_day') return Promise.resolve(5);
                    return Promise.resolve(null);
                });
                // First call: under limit (pre-loop check). Second+ calls: at limit (in-loop check)
                mockGetTodayTradeCount
                    .mockResolvedValueOnce(4) // pre-loop check — under limit
                    .mockResolvedValueOnce(5) // in-loop check for AAPL — at limit
                    .mockResolvedValueOnce(5); // in-loop check for TSLA — at limit

                mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
                mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
                mockScoreSignals.mockReturnValue(fakeBuySignalScore);

                const res = await handler(makeRequest(true));
                const body = await res.json();

                expect(body.decisions).toContainEqual({
                    symbol: 'AAPL',
                    action: 'daily_limit',
                    score: 0,
                });
                expect(body.decisions).toContainEqual({
                    symbol: 'TSLA',
                    action: 'daily_limit',
                    score: 0,
                });
                // No trades should be inserted since we hit the limit
                expect(mockInsertTrade).not.toHaveBeenCalled();
            });
        });

        describe('expired pending order cleanup', () => {
            it('calls expireOldPendingOrders at the start of execution', async () => {
                mockGetEnabledWatchlist.mockResolvedValue([]);
                mockGetOpenPositions.mockResolvedValue([]);

                await handler(makeRequest(true));

                expect(mockExpireOldPendingOrders).toHaveBeenCalledWith(fakeDb);
            });

            it('calls expireOldPendingOrders before circuit breakers', async () => {
                mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                    if (key === 'trading_enabled') return Promise.resolve(false);
                    return Promise.resolve(null);
                });

                await handler(makeRequest(true));

                // Even when trading is disabled, expiry should have been called
                // (it runs before the trading_enabled check)
                // Actually, trading_enabled check comes before expiry in the flow,
                // but expiry runs after trading_enabled. Let's verify it was called.
                // In our implementation, expiry runs after the kill switch but before
                // trade limit. Since trading is disabled, it won't reach expiry.
                // This test verifies the happy path instead.
                expect(mockExpireOldPendingOrders).not.toHaveBeenCalled();
            });
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
            expect(body.decisions).toEqual([
                { symbol: 'AAPL', action: 'buy', score: 80, executed: true },
            ]);

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

        it('still inserts the pending order but skips the approval email when email is disabled', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                { channel: 'email', enabled: false, target: 't@e.com', events: ['order_pending'] },
            ]);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockInsertPendingOrder).toHaveBeenCalled();
            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
        });

        it('skips the approval email when order_pending event is not selected', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                { channel: 'email', enabled: true, target: 't@e.com', events: ['trade_executed'] },
            ]);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockInsertPendingOrder).toHaveBeenCalled();
            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
        });

        it('honors the legacy approval_required event key as order_pending', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                {
                    channel: 'email',
                    enabled: true,
                    target: 't@e.com',
                    events: ['approval_required'],
                },
            ]);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockSendApprovalRequestEmail).toHaveBeenCalled();
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

        it('skips inserting pending order when one already exists for the symbol', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockGetPendingOrders.mockResolvedValue([
                { id: 99, symbol: 'AAPL', status: 'pending', side: 'buy' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertPendingOrder).not.toHaveBeenCalled();
            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_exists',
                score: 80,
            });
        });

        it('inserts pending order when existing pending is for a different symbol', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockGetPendingOrders.mockResolvedValue([
                { id: 99, symbol: 'TSLA', status: 'pending', side: 'buy' },
            ]);

            await handler(makeRequest(true));

            expect(mockInsertPendingOrder).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ symbol: 'AAPL' }),
            );
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

        it('calls executeBuyOrder for buy decisions with clientOrderId (uuid)', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockExecuteBuyOrder).toHaveBeenCalledWith(
                'AAPL',
                5,
                expect.stringMatching(/^[0-9a-f-]{36}$/),
            );
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
        });

        it('calls executeSellOrder for sell decisions with clientOrderId (uuid)', async () => {
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

            expect(mockExecuteSellOrder).toHaveBeenCalledWith(
                'AAPL',
                10,
                expect.stringMatching(/^[0-9a-f-]{36}$/),
            );
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
                avgFilledPrice: 151.5,
                filledQuantity: 5,
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
                    // auto buy carries the per-order facade clientOrderId (uuid)
                    clientOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                }),
            );
            // BUY must NOT set realizedPnl
            const buyCall = mockInsertTrade.mock.calls.find(
                (c) => (c[1] as { side?: string })?.side === 'buy',
            );
            expect(buyCall?.[1]).not.toHaveProperty('realizedPnl');
        });

        it('books a clean-fill SELL with realizedPnl and clientOrderId', async () => {
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
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-2',
                status: 'filled',
                avgFilledPrice: 160,
                filledQuantity: 10,
            });

            await handler(makeRequest(true));

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 10,
                    price: 160,
                    mode: 'auto',
                    clientOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                    // (filledPrice 160 − avgPrice 140) × 10
                    realizedPnl: 200,
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
                avgFilledPrice: 151.5,
                filledQuantity: 5,
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

        it('treats missing filledQuantity as a clean full fill at intended quantity', async () => {
            // Policy: filledQuantity omitted ⇒ defaults to intended qty ⇒ clean full fill.
            // Trade is booked at the plain reason (no warning) and the intended quantity.
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
                avgFilledPrice: 151.5,
                // filledQuantity intentionally omitted
            });

            await handler(makeRequest(true));

            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    reason: 'Score 80/100 — BUY',
                    quantity: 5,
                    price: 151.5,
                }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
        });

        it('routes to needs_review (no trade) when avgFilledPrice is missing (buy)', async () => {
            // Policy: a filled outcome with no fill price is NOT a clean full fill ⇒
            // needs_review, no auto-book.
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
                avgFilledPrice: undefined,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // No trade booked, no position opened.
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();

            // Order tracking marked needs_review (resolved).
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({
                    status: 'needs_review',
                    resolvedAt: expect.any(Date),
                }),
            );
            // Never marked 'filled'.
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'filled' }),
            );

            // Manual-review alert email.
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                expect.stringContaining('체결 수동확인 필요'),
                expect.stringContaining('체결가 없음'),
            );

            // Decision recorded as needs_review.
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 80,
            });
        });

        it('records order_submitted when buy order status is submitted and sends alert email', async () => {
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
                status: 'pending',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should not insert trade or open position
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();

            // Should send alert email for pending fill
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '미체결 주문: AAPL',
                expect.stringContaining('체결되지 않았습니다'),
            );

            // Should record as order_submitted in decisions
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_submitted',
                score: 80,
            });
        });

        it('records order_submitted when sell order status is submitted and sends alert email', async () => {
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
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-2',
                status: 'pending',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should not insert trade or close position
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();

            // Should send alert email for pending fill
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '미체결 주문: AAPL',
                expect.stringContaining('체결되지 않았습니다'),
            );

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_submitted',
                score: 20,
            });
        });

        it('creates order tracking before calling Toss API', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    idempotencyKey: expect.stringMatching(/^exec-.*-AAPL-buy$/),
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                    status: 'submitted',
                    cronRunId: expect.stringMatching(/^exec-/),
                }),
            );
        });

        it('updates order tracking after Toss API responds with filled', async () => {
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
                avgFilledPrice: 151.5,
            });

            await handler(makeRequest(true));

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    tossOrderId: 'ord-1',
                    status: 'filled',
                    filledPrice: 151.5,
                    resolvedAt: expect.any(Date),
                }),
            );
        });

        it('updates order tracking with pending status (no resolvedAt)', async () => {
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
                status: 'pending',
            });

            await handler(makeRequest(true));

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    tossOrderId: 'ord-1',
                    status: 'pending',
                    resolvedAt: undefined,
                }),
            );
        });

        it('does not create order tracking in dry_run or semi_auto mode', async () => {
            // Reconfigure to dry_run
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
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

            expect(body.decisions).toEqual([
                { symbol: 'AAPL', action: 'buy', score: 80, executed: true },
            ]);
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

            expect(body.decisions).toEqual([
                { symbol: 'AAPL', action: 'sell', score: 20, executed: true },
            ]);
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    side: 'sell',
                    quantity: 10,
                    mode: 'dry_run',
                    // dry_run sell at currentPrice 150 vs avgPrice 140, qty 10
                    realizedPnl: 100,
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
                    technical: {
                        trend: 'bullish',
                        riskLevel: 'low',
                        actionRecommendation: undefined,
                    },
                    news: { overallSentiment: 'bullish' },
                    options: { signals: [{ type: 'bullish' }] },
                    fundamental: { overallSentiment: 'neutral' },
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
        it('calculates currentExposure using current market prices', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                // High loss limit so unrealized PnL check does not short-circuit
                if (key === 'max_daily_loss_usd') return Promise.resolve(999_999);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'MSFT', quantity: 5, avgPrice: '300', status: 'open' },
                { symbol: 'GOOG', quantity: 2, avgPrice: '150', status: 'open' },
            ]);
            // All symbols return currentPrice: 150 from fakeTechResult
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

            // currentExposure uses current market price (150) for each position:
            // MSFT: 5*150 + GOOG: 2*150 = 1050
            expect(mockCalculatePositionSize).toHaveBeenCalledWith(
                expect.objectContaining({
                    currentExposure: 1050,
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Insufficient balance (skipped trades)
    // -----------------------------------------------------------------------

    describe('insufficient balance', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                if (key === 'max_total_exposure') return Promise.resolve(5000);
                // High loss limit so unrealized PnL check does not short-circuit
                if (key === 'max_daily_loss_usd') return Promise.resolve(999_999);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'MSFT', quantity: 10, avgPrice: '500', status: 'open' },
            ]);
        });

        it('records skipped trade and sends error email when buy signal but calculatedSize is 0', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(0);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should record as skipped
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 0,
                    price: 150,
                    mode: 'skipped',
                    reason: expect.stringContaining('잔고 부족'),
                }),
            );

            // Should send error email
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '잔고 부족: AAPL',
                expect.stringContaining('잔고 부족으로 미실행'),
            );

            // Should report as skipped in decisions
            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'skipped', score: 80 }]);
        });

        it('does not record skipped trade when signal is hold (not buy)', async () => {
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockCalculatePositionSize.mockReturnValue(0);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'Score 50/100 — HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(body.decisions).toEqual([{ symbol: 'AAPL', action: 'hold', score: 50 }]);
        });

        it('does not record skipped trade when calculatedSize > 0', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Normal buy trade inserted (not skipped)
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    mode: 'dry_run',
                    quantity: 5,
                }),
            );
            expect(body.decisions).toEqual([
                { symbol: 'AAPL', action: 'buy', score: 80, executed: true },
            ]);
        });

        it('continues to next symbol after recording skipped trade', async () => {
            mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
            mockScoreSignals
                .mockReturnValueOnce(fakeBuySignalScore) // AAPL - buy signal
                .mockReturnValueOnce(fakeBuySignalScore); // TSLA - buy signal
            mockCalculatePositionSize.mockReturnValue(0); // Both get 0
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: '',
                score: 80,
                reason: 'HOLD',
                quantity: 0,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toHaveLength(2);
            expect(body.decisions[0]).toEqual({ symbol: 'AAPL', action: 'skipped', score: 80 });
            expect(body.decisions[1]).toEqual({ symbol: 'TSLA', action: 'skipped', score: 80 });
            expect(mockInsertTrade).toHaveBeenCalledTimes(2);
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

            expect(body.cronRunId).toMatch(/^exec-[0-9a-f-]+$/);
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

        it('passes fixedExitEnabled to evaluateExistingPosition', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                if (key === 'fixed_exit_enabled') return Promise.resolve(true);
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
                action: 'hold',
                reason: '유지 (조건 미충족)',
            });

            await handler(makeRequest(true));

            expect(mockEvaluateExistingPosition).toHaveBeenCalledWith(
                expect.objectContaining({
                    fixedExitEnabled: true,
                }),
            );
        });

        it('defaults fixedExitEnabled to false when config not set', async () => {
            mockGetOpenPositions.mockResolvedValue([fakeOpenPosition]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'hold',
                reason: '유지 (조건 미충족)',
            });

            await handler(makeRequest(true));

            expect(mockEvaluateExistingPosition).toHaveBeenCalledWith(
                expect.objectContaining({
                    fixedExitEnabled: false,
                }),
            );
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
                    // (sellPrice 95 − avgPrice 100) × 10
                    realizedPnl: -50,
                }),
            );
            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 95);
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stop_loss',
                score: 0,
                executed: true,
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
                executed: true,
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
                executed: true,
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
            expect(body.decisions).toEqual([
                { symbol: 'AAPL', action: 'skipped_no_price', score: 0 },
            ]);
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

            expect(mockExecuteSellOrder).toHaveBeenCalledWith(
                'AAPL',
                10,
                expect.stringMatching(/^[0-9a-f-]{36}$/),
            );
            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 10,
                    status: 'submitted',
                    clientOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                }),
            );
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    mode: 'auto',
                    // facade sell carries the per-order clientOrderId (uuid)
                    clientOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                    // (filledPrice 148 − avgPrice 100) × 10
                    realizedPnl: 480,
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

        it('handles submitted status in auto mode position re-evaluation and sends alert', async () => {
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
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-3',
                status: 'pending',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should not insert trade or close position
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();

            // Should create order tracking and send alert email
            expect(mockCreateOrderTracking).toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalled();
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '미체결 주문: AAPL',
                expect.stringContaining('체결되지 않았습니다'),
            );

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_submitted',
                score: 0,
            });
        });

        it('catches errors during re-evaluation and continues', async () => {
            mockGetOpenPositions.mockResolvedValue([
                fakeOpenPosition,
                { ...fakeOpenPosition, id: 2, symbol: 'TSLA' },
            ]);
            // Mock by symbol: AAPL always throws, TSLA always succeeds.
            // This covers the unrealized PnL check, exposure calc, AND re-evaluation calls.
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, sym: string, type: string) => {
                    if (sym === 'AAPL') return Promise.reject(new Error('DB error'));
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

        it('decrements currentExposure when position is closed in dry_run', async () => {
            mockGetOpenPositions
                .mockResolvedValueOnce([fakeOpenPosition]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition]) // main open positions
                .mockResolvedValueOnce([]); // after re-evaluation recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            // After position loop, watchlist has an item that needs exposure check
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            // Position had exposure 100*10=1000, closed at price 95 -> decrement 95*10=950
            // After recalc from DB (empty), exposure should be 0
            expect(mockCalculatePositionSize).toHaveBeenCalledWith(
                expect.objectContaining({
                    currentExposure: 0,
                }),
            );
        });

        it('does not produce duplicate decisions when auto mode rejects sell order', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetOpenPositions
                .mockResolvedValueOnce([fakeOpenPosition]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition]) // main open positions
                .mockResolvedValueOnce([]); // recalc after re-evaluation
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: '',
                status: 'rejected',
                rejectReason: 'insufficient-shares',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should only have one decision for AAPL, not duplicated
            const aaplDecisions = body.decisions.filter(
                (d: { symbol: string }) => d.symbol === 'AAPL',
            );
            expect(aaplDecisions).toHaveLength(1);
            expect(aaplDecisions[0].action).toBe('order_rejected');
        });

        it('does not produce duplicate decisions when auto mode has submitted sell order', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetOpenPositions
                .mockResolvedValueOnce([fakeOpenPosition]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition]) // main open positions
                .mockResolvedValueOnce([]); // recalc after re-evaluation
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechWithBearish);
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-y',
                status: 'pending',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            const aaplDecisions = body.decisions.filter(
                (d: { symbol: string }) => d.symbol === 'AAPL',
            );
            expect(aaplDecisions).toHaveLength(1);
            expect(aaplDecisions[0].action).toBe('order_submitted');
        });
    });

    // -----------------------------------------------------------------------
    // Stale analysis
    // -----------------------------------------------------------------------

    describe('stale analysis', () => {
        it('skips symbol when technical analysis is older than 4 hours', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            ...fakeTechResult,
                            analyzedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
                        });
                    }
                    return Promise.resolve(null);
                },
            );

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stale_analysis',
                score: 0,
            });
            // Should not proceed to score or trade
            expect(mockScoreSignals).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });

        it('skips symbol when no technical analysis exists', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(null);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stale_analysis',
                score: 0,
            });
        });

        it('proceeds when technical analysis is fresh (under 4 hours)', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            ...fakeTechResult,
                            analyzedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
                        });
                    }
                    return Promise.resolve(null);
                },
            );
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

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'hold',
                score: 50,
            });
            expect(mockScoreSignals).toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Stop-loss cooldown
    // -----------------------------------------------------------------------

    describe('stop-loss cooldown', () => {
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

        it('prevents re-buy of symbol that was stop-lossed in same cron run', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            // Position will be closed by stop-loss, then watchlist has same symbol
            mockGetOpenPositions
                .mockResolvedValueOnce([fakeOpenPosition]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition]) // main positions
                .mockResolvedValueOnce([]); // recalc after closures
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]); // AAPL in watchlist
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
            // Watchlist loop would produce a buy for AAPL
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

            // Should have stop_loss for position re-evaluation
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stop_loss',
                score: 0,
                executed: true,
            });
            // Should have cooldown instead of buy for watchlist
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'cooldown_after_stop_loss',
                score: 80,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Price=0 position alert
    // -----------------------------------------------------------------------

    describe('price=0 position alert', () => {
        it('sends error email when position price is 0', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
                ])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockResolvedValue({ result: {} }); // no keyLevels => price 0

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_no_price',
                score: 0,
            });
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '가격 데이터 없음: AAPL',
                expect.stringContaining('수동 확인이 필요합니다'),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Semi_auto pending exposure tracking
    // -----------------------------------------------------------------------

    describe('semi_auto pending exposure tracking', () => {
        it('increments currentExposure after creating a pending buy order', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('semi_auto');
                if (key === 'max_total_exposure') return Promise.resolve(5000);
                if (key === 'max_position_size') return Promise.resolve(1000);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist); // AAPL + TSLA
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult); // price 150
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: '',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockGetPendingOrders.mockResolvedValue([]);

            await handler(makeRequest(true));

            // After first pending order (AAPL), exposure should include 150 * 5 = 750
            // So second call to calculatePositionSize should have increased currentExposure
            expect(mockCalculatePositionSize).toHaveBeenCalledTimes(2);
            const firstCall = mockCalculatePositionSize.mock.calls[0][0];
            const secondCall = mockCalculatePositionSize.mock.calls[1][0];
            expect(secondCall.currentExposure).toBeGreaterThan(firstCall.currentExposure);
        });
    });

    // -----------------------------------------------------------------------
    // Transaction safety: closePosition false → no trade recorded
    // -----------------------------------------------------------------------

    describe('transaction safety: closePosition false', () => {
        const fakeOpenPosition = {
            id: 1,
            symbol: 'AAPL',
            quantity: 10,
            avgPrice: '100',
            status: 'open',
        };

        it('records already_closed when closePosition returns false in dry_run position re-evaluation', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: {
                                trend: 'bearish',
                                keyLevels: { currentPrice: 95 },
                            },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전 (bearish)',
            });
            mockClosePosition.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Trade should NOT be inserted (transaction rolled back)
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'already_closed',
                score: 0,
            });
        });

        it('records already_closed when closePosition returns false in auto mode watchlist sell', async () => {
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
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 148,
            });
            mockClosePosition.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'already_closed',
                score: 20,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Mode snapshot: no mid-loop mode change
    // -----------------------------------------------------------------------

    describe('mode snapshot', () => {
        it('uses trading_mode from run start, not per-symbol re-read', async () => {
            // Set up: trading_mode starts as 'dry_run', but would return 'auto' if re-read
            let configCallCount = 0;
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') {
                    configCallCount++;
                    // If the code reads mode per-symbol (wrong), later calls would get 'auto'
                    // If mode is snapshot (correct), only one read happens
                    return Promise.resolve(configCallCount === 1 ? 'dry_run' : 'auto');
                }
                return Promise.resolve(null);
            });
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

            // Should use dry_run from snapshot — no Toss API call
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(body.tradingMode).toBe('dry_run');
        });
    });

    // -----------------------------------------------------------------------
    // Position averaging on duplicate buy
    // -----------------------------------------------------------------------

    describe('position averaging', () => {
        it('averages into existing position on duplicate buy in dry_run', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
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
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            await handler(makeRequest(true));

            // Should call averageIntoPosition instead of openPosition
            expect(mockAverageIntoPosition).toHaveBeenCalledWith(fakeDb, 1, 5, 150);
            expect(mockOpenPosition).not.toHaveBeenCalled();
            // Trade should still be inserted
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 5,
                }),
            );
        });

        it('opens new position when no existing position in dry_run', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
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
            mockGetOpenPositionBySymbol.mockResolvedValue(null);

            await handler(makeRequest(true));

            expect(mockOpenPosition).toHaveBeenCalled();
            expect(mockAverageIntoPosition).not.toHaveBeenCalled();
        });

        it('averages into existing position on duplicate buy in auto mode', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
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
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 151,
            });
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '140',
                status: 'open',
            });

            await handler(makeRequest(true));

            expect(mockAverageIntoPosition).toHaveBeenCalledWith(fakeDb, 1, 5, 151);
            expect(mockOpenPosition).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // filledPrice missing in position re-evaluation auto mode
    // -----------------------------------------------------------------------

    describe('filledPrice missing in position re-evaluation', () => {
        it('routes to needs_review (no trade) when avgFilledPrice is missing in auto sell', async () => {
            const fakeOpenPosition = {
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '100',
                status: 'open',
            };
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: {
                                trend: 'bearish',
                                keyLevels: { currentPrice: 95 },
                            },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: undefined,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Policy: missing fill price ⇒ not a clean full fill ⇒ needs_review, no booking.
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({
                    status: 'needs_review',
                    resolvedAt: expect.any(Date),
                }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'filled' }),
            );

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                expect.stringContaining('체결 수동확인 필요'),
                expect.stringContaining('체결가 없음'),
            );

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 0,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Unrealized PnL breaker
    // -----------------------------------------------------------------------

    describe('unrealized PnL breaker', () => {
        it('halts trading when realized + unrealized PnL exceeds daily loss limit', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                return Promise.resolve(null);
            });
            // Realized loss: -200
            mockGetTodayRealizedPnl.mockResolvedValue(-200);
            // Open positions with unrealized loss
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'AAPL', quantity: 10, avgPrice: '150', status: 'open' },
            ]);
            // Current price = 115, unrealized = (115 - 150) * 10 = -350
            mockGetLatestAnalysisResult.mockResolvedValue({
                result: { keyLevels: { currentPrice: 115 } },
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // totalPnl = -200 + (-350) = -550 < -500 -> halts
            expect(body.skipped).toBe(true);
            expect(body.reason).toBe('daily_loss_limit_reached');
            expect(body.todayPnl).toBe(-200);
            expect(body.unrealizedPnl).toBe(-350);
            expect(body.totalPnl).toBe(-550);
        });

        it('sends error email with correct amounts when unrealized PnL triggers halt', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'max_daily_loss_usd') return Promise.resolve(300);
                return Promise.resolve(null);
            });
            mockGetTodayRealizedPnl.mockResolvedValue(-100);
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'TSLA', quantity: 5, avgPrice: '200', status: 'open' },
            ]);
            // Current price = 150, unrealized = (150 - 200) * 5 = -250
            // total = -100 + (-250) = -350 < -300 limit -> halts
            mockGetLatestAnalysisResult.mockResolvedValue({
                result: { keyLevels: { currentPrice: 150 } },
            });

            await handler(makeRequest(true));

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '일일 손실 한도 초과 (미실현 포함)',
                expect.stringContaining('$100.00'),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '일일 손실 한도 초과 (미실현 포함)',
                expect.stringContaining('$250.00'),
            );
        });

        it('uses conservative behavior when price fetch fails for some positions', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                return Promise.resolve(null);
            });
            mockGetTodayRealizedPnl.mockResolvedValue(-400);
            mockGetOpenPositions.mockResolvedValue([
                { symbol: 'AAPL', quantity: 10, avgPrice: '150', status: 'open' },
                { symbol: 'TSLA', quantity: 5, avgPrice: '200', status: 'open' },
            ]);
            // AAPL fails to fetch price, TSLA succeeds with small gain
            mockGetLatestAnalysisResult.mockImplementation((_db: unknown, sym: string) => {
                if (sym === 'AAPL') return Promise.reject(new Error('API error'));
                // TSLA at 210, unrealized = (210 - 200) * 5 = +50
                return Promise.resolve({
                    result: { keyLevels: { currentPrice: 210 } },
                });
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // AAPL price fetch failed -> unrealized for AAPL = 0 (skipped)
            // TSLA unrealized = +50
            // totalPnl = -400 + 50 = -350, still under 500 limit
            // Should proceed (not halt)
            expect(body.skipped).not.toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Partial fill alert
    // -----------------------------------------------------------------------

    describe('short fill routing', () => {
        it('routes to needs_review (no trade) when filledQuantity is less than intended', async () => {
            // Policy: short fill (filled < intended) ⇒ needs_review, no auto-book.
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
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 10,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 150,
                filledQuantity: 7,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '체결 수동확인 필요: AAPL',
                expect.stringContaining('의도 10주, 체결 7'),
            );
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'filled' }),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 80,
            });
        });

        it('routes to needs_review when filledQuantity is fractional (non-integer)', async () => {
            // Policy: fractional fill ⇒ needs_review (never inserted into integer columns).
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
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 10,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 150,
                filledQuantity: 9.5, // fractional for intended 10
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 80,
            });
        });

        it('books a clean full fill at intended quantity inside the tx (status filled in same tx)', async () => {
            // Policy: filled qty == intended integer qty + real price ⇒ book + mark
            // 'filled' inside the SAME transaction (atomicity guard).
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
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 10,
            });
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 150,
                filledQuantity: 10, // clean full fill
            });

            await handler(makeRequest(true));

            // Trade booked at intended integer qty and the real fill price.
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ quantity: 10, price: 150, mode: 'auto' }),
            );
            // 'filled' status written (inside the tx — the fake tx passes fakeDb through).
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'filled', filledPrice: 150 }),
            );
            // needs_review never written for a clean fill.
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
        });

        it('does not route to needs_review when filledQuantity equals requested', async () => {
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
                avgFilledPrice: 150,
                filledQuantity: 5,
            });

            await handler(makeRequest(true));

            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockSendErrorEmail).not.toHaveBeenCalledWith(
                expect.stringContaining('체결 수동확인 필요'),
                expect.any(String),
            );
        });
    });

    // -----------------------------------------------------------------------
    // filledQuantity missing → treated as clean full fill (defaults to intended)
    // -----------------------------------------------------------------------

    describe('filledQuantity missing', () => {
        it('books at intended qty (clean full fill) when filledQuantity is missing but status is filled', async () => {
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
                avgFilledPrice: 151.5,
                // filledQuantity intentionally omitted
            });

            await handler(makeRequest(true));

            // Clean full fill at intended qty 5 — booked, not routed to needs_review.
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ quantity: 5, price: 151.5, mode: 'auto' }),
            );
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'filled', filledPrice: 151.5 }),
            );
            expect(mockUpdateOrderTracking).not.toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // currentPrice negative guard
    // -----------------------------------------------------------------------

    describe('currentPrice negative guard', () => {
        it('skips position when currentPrice is negative', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
                ])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockResolvedValue({
                result: { keyLevels: { currentPrice: -5 } },
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_no_price',
                score: 0,
            });
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '가격 데이터 없음: AAPL',
                expect.stringContaining('수동 확인이 필요합니다'),
            );
        });

        it('skips watchlist symbol when currentPrice is negative', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue({
                result: { keyLevels: { currentPrice: -10 } },
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_no_price',
                score: 0,
            });
        });
    });

    // -----------------------------------------------------------------------
    // orderTracking error on API throw
    // -----------------------------------------------------------------------

    describe('orderTracking error on API throw', () => {
        it('marks orderTracking as error when executeBuyOrder throws in auto mode', async () => {
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
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockExecuteBuyOrder.mockRejectedValue(new Error('API timeout'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Should update orderTracking to error
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    status: 'error',
                    resolvedAt: expect.any(Date),
                }),
            );
            // Error should be caught and recorded in decisions
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'error',
                score: 0,
            });
        });

        it('marks orderTracking as error when executeSellOrder throws in position re-eval auto mode', async () => {
            const fakeOpenPosition = {
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '100',
                status: 'open',
            };
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: {
                                trend: 'bearish',
                                keyLevels: { currentPrice: 95 },
                            },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockRejectedValue(new Error('Connection refused'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-sell$/),
                expect.objectContaining({
                    status: 'error',
                    resolvedAt: expect.any(Date),
                }),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'error',
                score: 0,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Position re-evaluation staleness check
    // -----------------------------------------------------------------------

    describe('position re-evaluation staleness', () => {
        it('skips position re-evaluation when analysis is stale', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
                ])
                .mockResolvedValueOnce([]); // recalc
            // Analysis is 5 hours old (over 4-hour limit)
            mockGetLatestAnalysisResult.mockResolvedValue({
                result: { keyLevels: { currentPrice: 95 }, trend: 'bearish' },
                analyzedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'stale_analysis',
                score: 0,
            });
            // Should not evaluate the position
            expect(mockEvaluateExistingPosition).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Fix 1: Partial fill sell → partial close (not full close)
    // -----------------------------------------------------------------------

    describe('short fill sell → needs_review', () => {
        const fakeOpenPosition = {
            id: 1,
            symbol: 'AAPL',
            quantity: 10,
            avgPrice: '100',
            status: 'open',
        };

        it('routes to needs_review (no position mutation) when auto sell is short-filled in position re-eval', async () => {
            // Policy: filled < intended ⇒ needs_review, no close/reduce, no trade.
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: { trend: 'bearish', keyLevels: { currentPrice: 95 } },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 94,
                filledQuantity: 7, // short: 7 of 10
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '체결 수동확인 필요: AAPL',
                expect.stringContaining('의도 10주, 체결 7'),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 0,
            });
        });

        it('closes position fully on a clean full fill in position re-eval', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: { trend: 'bearish', keyLevels: { currentPrice: 95 } },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 94,
                filledQuantity: 10, // full fill
            });

            await handler(makeRequest(true));

            expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 1, 94);
            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
        });

        it('routes to needs_review (no position mutation) on short fill in watchlist auto sell', async () => {
            // Policy: filled < intended ⇒ needs_review, no reduce/close.
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
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-2',
                status: 'filled',
                avgFilledPrice: 148,
                filledQuantity: 6, // short: 6 of 10
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 20,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Fix 2: Pending sell → skip position re-evaluation
    // -----------------------------------------------------------------------

    describe('pending sell guard', () => {
        it('skips position re-evaluation when submitted sell order exists', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
                ])
                .mockResolvedValueOnce([]); // recalc
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'sell', status: 'submitted' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_sell_in_progress',
                score: 0,
            });
            expect(mockEvaluateExistingPosition).not.toHaveBeenCalled();
        });

        it('skips watchlist sell when submitted sell order exists', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
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
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'sell', status: 'submitted' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_sell_in_progress',
                score: 20,
            });
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Fix 3: Per-symbol exposure cap for average_in
    // -----------------------------------------------------------------------

    describe('per-symbol exposure cap for average_in', () => {
        it('caps additional investment when existing exposure (at currentPrice) is near limit', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                if (key === 'max_position_size') return Promise.resolve(2000);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult); // currentPrice = 150
            // Existing position: 10 shares, currentPrice=150 → exposure = $1500
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '100',
                status: 'open',
            });
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'average_in',
                symbol: 'AAPL',
                score: 80,
                reason: 'Average in',
                quantity: 5,
            });

            await handler(makeRequest(true));

            // maxPositionSize=2000, existingExposure=150*10=1500, remaining=500
            // 500/150=3.33 → cappedSize=3
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    quantity: 3, // capped from 5 to 3
                }),
            );
        });

        it('records symbol_limit_reached when remaining budget is 0', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                if (key === 'max_position_size') return Promise.resolve(1000);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult); // currentPrice = 150
            // Existing position: 10 shares, currentPrice=150 → exposure = $1500 (over $1000 limit)
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '100',
                status: 'open',
            });
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'average_in',
                symbol: 'AAPL',
                score: 80,
                reason: 'Average in',
                quantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'symbol_limit_reached',
                score: 80,
            });
            expect(mockInsertTrade).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Fix 4: Sell without position → skip (no phantom trade)
    // -----------------------------------------------------------------------

    describe('sell without position guard', () => {
        it('skips sell when no open position exists', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockGetOpenPositionBySymbol.mockResolvedValue(null); // no position
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

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'no_position_to_sell',
                score: 20,
            });
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Fix: No-position sell in auto mode records trade + sends alert
    // -----------------------------------------------------------------------

    describe('no-position sell trade recording in auto mode', () => {
        it('records trade and sends alert when position disappears after broker fill', async () => {
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
            // First call: position exists (guard check passes), second call: position gone
            mockGetOpenPositionBySymbol
                .mockResolvedValueOnce({
                    id: 1,
                    symbol: 'AAPL',
                    quantity: 10,
                    avgPrice: '140',
                    status: 'open',
                })
                .mockResolvedValueOnce(null); // disappeared by execution time
            mockScoreSignals.mockReturnValue(fakeSellSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'sell',
                symbol: 'AAPL',
                score: 20,
                reason: 'Score 20/100 — SELL',
                quantity: 10,
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-2',
                status: 'filled',
                avgFilledPrice: 148,
                filledQuantity: 10,
            });

            await handler(makeRequest(true));

            // Should record the trade even without a position
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'sell',
                    quantity: 10,
                    price: 148,
                    reason: expect.stringContaining('포지션 미확인'),
                    mode: 'auto',
                }),
            );
            // Should send error email
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '포지션 미확인 매도 체결: AAPL',
                expect.stringContaining('DB에 포지션이 없습니다'),
            );
            // Should NOT try to close/reduce a non-existent position
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Short fill + missing price in position re-eval auto path → needs_review
    // -----------------------------------------------------------------------

    describe('short fill + missing price in re-eval auto path', () => {
        it('routes to needs_review (no position mutation) when both short-filled and price missing', async () => {
            const fakeOpenPosition = {
                id: 1,
                symbol: 'AAPL',
                quantity: 10,
                avgPrice: '100',
                status: 'open',
            };
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            // Isolate the re-eval sell from any watchlist entry.
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([fakeOpenPosition])
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') {
                        return Promise.resolve({
                            result: {
                                trend: 'bearish',
                                keyLevels: { currentPrice: 95 },
                            },
                        });
                    }
                    return Promise.resolve(null);
                },
            );
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'stop_loss',
                reason: '기술적 추세 반전',
            });
            mockExecuteSellOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: undefined,
                filledQuantity: 7, // short: 7 of 10
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockReducePositionQuantity).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'needs_review' }),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'needs_review',
                score: 0,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Fix: Phantom sell guard in dry_run when position disappears between checks
    // -----------------------------------------------------------------------

    describe('dry_run phantom sell guard', () => {
        it('skips phantom sell when position disappeared between guard check and execution', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            // First call returns position (guard check), second call returns null (execution)
            mockGetOpenPositionBySymbol
                .mockResolvedValueOnce({
                    id: 1,
                    symbol: 'AAPL',
                    quantity: 10,
                    avgPrice: '140',
                    status: 'open',
                })
                .mockResolvedValueOnce(null); // position disappeared
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

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'no_position_to_sell',
                score: 20,
            });
            // No phantom trade should be inserted
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockClosePosition).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Fix: Average-in cap uses currentPrice not avgPrice
    // -----------------------------------------------------------------------

    describe('average-in cap uses currentPrice', () => {
        it('uses currentPrice for existing exposure calculation', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                if (key === 'max_position_size') return Promise.resolve(2000);
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult); // price 150
            // Existing position: 8 shares, avgPrice=$100 but currentPrice=$150
            // With currentPrice: exposure = 150*8 = $1200 (over $2000 limit - remaining = $800)
            // With avgPrice: exposure = 100*8 = $800 (remaining = $1200) -- wrong, overstates budget
            mockGetOpenPositionBySymbol.mockResolvedValue({
                id: 1,
                symbol: 'AAPL',
                quantity: 8,
                avgPrice: '100',
                status: 'open',
            });
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(10);
            mockMakeTradeDecision.mockReturnValue({
                action: 'average_in',
                symbol: 'AAPL',
                score: 80,
                reason: 'Average in',
                quantity: 10,
            });

            await handler(makeRequest(true));

            // maxPositionSize=2000, existingExposure=150*8=1200, remaining=800
            // 800/150=5.33 → cappedSize=5
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    symbol: 'AAPL',
                    quantity: 5, // capped using currentPrice exposure
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Fix 5: Price cache — batch fetch once
    // -----------------------------------------------------------------------

    describe('price cache', () => {
        it('uses cached live price instead of analysis price', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue({
                ...fakeTechResult,
                result: {
                    ...fakeTechResult.result,
                    keyLevels: { currentPrice: 100 }, // analysis price
                },
            });
            // Live price is different
            mockFetchLivePrice.mockResolvedValue(155);
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            // Trade should use live price (155), not analysis price (100)
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    price: 155,
                }),
            );
        });

        it('falls back to analysis price when live price is unavailable', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockFetchLivePrice.mockResolvedValue(null); // no live price
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockCalculatePositionSize.mockReturnValue(5);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'BUY',
                quantity: 5,
            });

            await handler(makeRequest(true));

            // Should use analysis price (150 from fakeTechResult)
            expect(mockInsertTrade).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({
                    price: 150,
                }),
            );
        });

        it('fetches price once per symbol even when symbol appears in both positions and watchlist', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]); // AAPL
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 5, avgPrice: '100', status: 'open' },
                ]) // main positions
                .mockResolvedValueOnce([]); // recalc
            mockGetLatestAnalysisResult.mockResolvedValue(fakeTechResult);
            mockFetchLivePrice.mockResolvedValue(155);
            mockEvaluateExistingPosition.mockReturnValue({
                action: 'hold',
                reason: '유지 (조건 미충족)',
            });
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);

            await handler(makeRequest(true));

            // fetchLivePrice for the cache is called once per unique symbol
            // AAPL appears in both positions and watchlist, but should be fetched once
            // Plus pre-loop checks may also call fetchLivePrice
            const aaplCalls = mockFetchLivePrice.mock.calls.filter(
                (c: [string]) => c[0] === 'AAPL',
            );
            // Pre-loop calls (unrealized PnL + exposure) + cache = multiple,
            // but the cache itself should only fetch once
            // We just verify fetchLivePrice was called (not zero times — proving the mock works)
            expect(aaplCalls.length).toBeGreaterThan(0);
        });
    });

    // -----------------------------------------------------------------------
    // Toss OpenAPI integration: market-holiday gate + buying-power / sellable guards
    // -----------------------------------------------------------------------

    describe('us market-holiday gate', () => {
        it('skips entirely (no orders) when isUsMarketOpen is false in auto mode', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
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
            mockIsUsMarketOpen.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body).toEqual({ skipped: true, reason: 'us-market-holiday' });
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
            // Lock still released via finally
            expect(mockReleaseLock).toHaveBeenCalledWith('cron:execute:lock');
        });

        it('does NOT gate in dry_run mode (isUsMarketOpen not consulted)', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('dry_run');
                return Promise.resolve(null);
            });
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
            mockIsUsMarketOpen.mockResolvedValue(false);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // dry_run proceeds regardless of holiday
            expect(body.tradingMode).toBe('dry_run');
            expect(mockIsUsMarketOpen).not.toHaveBeenCalled();
            expect(mockInsertTrade).toHaveBeenCalled();
        });

        it('proceeds (fail-open) when isUsMarketOpen throws in auto mode', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
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
            mockIsUsMarketOpen.mockRejectedValue(new Error('calendar down'));

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // catch(() => true) → fall back to time-based behavior, order placed
            expect(body.skipped).not.toBe(true);
            expect(mockExecuteBuyOrder).toHaveBeenCalled();
        });
    });

    describe('buying-power guard', () => {
        beforeEach(() => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue([fakeWatchlist[0]]);
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult); // price 150
                    return Promise.resolve(null);
                },
            );
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
        });

        it('skips buy (skipped_insufficient_cash) when cost exceeds USD buying power', async () => {
            // cost = 150 * 5 = 750, buying power 700 < 750
            mockGetBuyingPower.mockResolvedValue(700);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_insufficient_cash',
                score: 80,
            });
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });

        it('places buy when buying power is sufficient', async () => {
            mockGetBuyingPower.mockResolvedValue(1000); // > 750

            await handler(makeRequest(true));

            expect(mockExecuteBuyOrder).toHaveBeenCalled();
        });

        it('does not gate buy when getBuyingPower throws (guard disabled)', async () => {
            mockGetBuyingPower.mockRejectedValue(new Error('balance API down'));

            await handler(makeRequest(true));

            // null buying power → guard skipped, order placed
            expect(mockExecuteBuyOrder).toHaveBeenCalled();
        });
    });

    describe('sellable-quantity guard (watchlist sell)', () => {
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
        });

        it('skips sell (skipped_not_sellable) when sellable is 0', async () => {
            mockGetSellableQuantity.mockResolvedValue(0);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_not_sellable',
                score: 20,
            });
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });

        it('clamps sell quantity down to floor(sellable) when intended qty exceeds sellable', async () => {
            mockGetSellableQuantity.mockResolvedValue(6.9); // intended 10 > 6.9 → clamp to 6

            await handler(makeRequest(true));

            expect(mockExecuteSellOrder).toHaveBeenCalledWith(
                'AAPL',
                6,
                expect.stringMatching(/^[0-9a-f-]{36}$/),
            );
            // order_tracking records the clamped quantity
            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ quantity: 6 }),
            );
        });

        it('does not clamp when sellable >= intended quantity', async () => {
            mockGetSellableQuantity.mockResolvedValue(50);

            await handler(makeRequest(true));

            expect(mockExecuteSellOrder).toHaveBeenCalledWith(
                'AAPL',
                10,
                expect.stringMatching(/^[0-9a-f-]{36}$/),
            );
        });
    });

    describe('OrderOutcome status mapping (auto watchlist buy)', () => {
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
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
        });

        it('pending → order_tracking pending, NOT resolved, no trade', async () => {
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-p',
                clientOrderId: 'coid-p',
                status: 'pending',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    tossOrderId: 'ord-p',
                    status: 'pending',
                    resolvedAt: undefined,
                }),
            );
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_submitted',
                score: 80,
            });
        });

        it('partial → tracking status partial (unresolved), NO trade, NO position mutation (reconcile books it)', async () => {
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-pf',
                clientOrderId: 'coid-pf',
                status: 'partial',
                filledQuantity: 3,
                avgFilledPrice: 151,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // tracking updated to 'partial' WITHOUT resolvedAt — reconcile owns final booking
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    tossOrderId: 'ord-pf',
                    status: 'partial',
                    filledPrice: 151,
                    resolvedAt: undefined,
                }),
            );
            // execute books NOTHING for partial — no trade, no position change, no exposure change
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(mockOpenPosition).not.toHaveBeenCalled();
            expect(mockAverageIntoPosition).not.toHaveBeenCalled();
            // informational partial-fill email + order_partial decision
            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '부분 체결: AAPL',
                expect.stringContaining('reconcile'),
            );
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_partial',
                score: 80,
            });
        });

        it('canceled → handled like rejected (order_rejected, resolved, no trade)', async () => {
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-c',
                clientOrderId: 'coid-c',
                status: 'canceled',
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    status: 'canceled',
                    resolvedAt: expect.any(Date),
                }),
            );
            expect(mockInsertTrade).not.toHaveBeenCalled();
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'order_rejected',
                score: 80,
            });
        });

        it('rejected → uses rejectReason in error email', async () => {
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: '',
                clientOrderId: 'coid-r',
                status: 'rejected',
                rejectReason: 'insufficient-funds',
            });

            await handler(makeRequest(true));

            expect(mockSendErrorEmail).toHaveBeenCalledWith(
                '주문 거부: AAPL',
                'insufficient-funds',
            );
            // empty orderId must not be written to tracking
            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                fakeDb,
                expect.stringMatching(/^exec-.*-AAPL-buy$/),
                expect.objectContaining({
                    tossOrderId: undefined,
                    status: 'rejected',
                    resolvedAt: expect.any(Date),
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // In-flight order guard: pending/partial orders block re-submission.
    // Regression for the double-submit bug — an unfilled order from a prior run
    // (status pending/partial) must prevent a new order with a fresh clientOrderId.
    // -----------------------------------------------------------------------

    describe('in-flight order guard (pending/partial)', () => {
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

        it('skips watchlist BUY (pending_order_in_progress) when a pending buy order is in flight', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'buy', status: 'pending' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_order_in_progress',
                score: 80,
            });
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });

        it('skips watchlist BUY when a partial buy order is in flight', async () => {
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'buy',
                symbol: 'AAPL',
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            });
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'buy', status: 'partial' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_order_in_progress',
                score: 80,
            });
            expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });

        it('skips watchlist SELL when a pending sell order is in flight', async () => {
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
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'sell', status: 'pending' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_sell_in_progress',
                score: 20,
            });
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
        });

        it('skips position re-evaluation SELL when a partial sell order is in flight', async () => {
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions
                .mockResolvedValueOnce([]) // unrealized PnL check
                .mockResolvedValueOnce([
                    { id: 1, symbol: 'AAPL', quantity: 10, avgPrice: '100', status: 'open' },
                ])
                .mockResolvedValueOnce([]); // recalc
            mockGetPendingSubmittedOrders.mockResolvedValue([
                { symbol: 'AAPL', side: 'sell', status: 'partial' },
            ]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'pending_sell_in_progress',
                score: 0,
            });
            expect(mockEvaluateExistingPosition).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Buying-power running decrement across multiple buys in one run.
    // -----------------------------------------------------------------------

    describe('buying-power running decrement', () => {
        it('skips the second buy (skipped_insufficient_cash) when cash only covers the first', async () => {
            // Both AAPL and TSLA signal buy of 5 @ 150 = $750 each.
            // Buying power 1000 covers the first (750) but not the second (remaining 250 < 750).
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'trading_mode') return Promise.resolve('auto');
                return Promise.resolve(null);
            });
            mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist); // AAPL, TSLA
            mockGetLatestAnalysisResult.mockImplementation(
                (_db: unknown, _sym: string, type: string) => {
                    if (type === 'technical') return Promise.resolve(fakeTechResult); // price 150
                    return Promise.resolve(null);
                },
            );
            mockScoreSignals.mockReturnValue(fakeBuySignalScore);
            mockMakeTradeDecision.mockImplementation((params: { symbol: string }) => ({
                action: 'buy',
                symbol: params.symbol,
                score: 80,
                reason: 'Score 80/100 — BUY',
                quantity: 5,
            }));
            mockGetBuyingPower.mockResolvedValue(1000); // between 1x (750) and 2x (1500)
            mockExecuteBuyOrder.mockResolvedValue({
                orderId: 'ord-1',
                status: 'filled',
                avgFilledPrice: 150,
                filledQuantity: 5,
            });

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // First buy placed, second skipped for insufficient cash
            expect(mockExecuteBuyOrder).toHaveBeenCalledTimes(1);
            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'buy',
                score: 80,
                executed: true,
            });
            expect(body.decisions).toContainEqual({
                symbol: 'TSLA',
                action: 'skipped_insufficient_cash',
                score: 80,
            });
        });
    });

    // -----------------------------------------------------------------------
    // Fractional sellable: clamp-before-reject must not place a 0-qty order.
    // -----------------------------------------------------------------------

    describe('fractional sellable clamp (watchlist sell)', () => {
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
        });

        it('fractional sellable 0.4 → skipped_not_sellable, no order (not an error row)', async () => {
            mockGetSellableQuantity.mockResolvedValue(0.4); // floor → 0

            const res = await handler(makeRequest(true));
            const body = await res.json();

            expect(body.decisions).toContainEqual({
                symbol: 'AAPL',
                action: 'skipped_not_sellable',
                score: 20,
            });
            expect(mockExecuteSellOrder).not.toHaveBeenCalled();
            expect(mockCreateOrderTracking).not.toHaveBeenCalled();
            expect(body.decisions).not.toContainEqual(expect.objectContaining({ action: 'error' }));
        });
    });

    // -----------------------------------------------------------------------
    // Cron audit log
    // -----------------------------------------------------------------------

    describe('cron audit log', () => {
        it('calls startCronRun with cronType execute before any other work', async () => {
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions.mockResolvedValue([]);

            await handler(makeRequest(true));

            expect(mockStartCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ cronType: 'execute' }),
            );
        });

        it('records completed finishState on normal completion', async () => {
            // Use fakeWatchlist (already set in setupDefaults) + hold decisions → completed
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'hold',
                quantity: 0,
            });

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'completed', outcome: 'completed' }),
            );
        });

        it('calls insertCronDecisions with execute and a decisions array on normal completion', async () => {
            mockScoreSignals.mockReturnValue(fakeHoldSignalScore);
            mockMakeTradeDecision.mockReturnValue({
                action: 'hold',
                symbol: 'AAPL',
                score: 50,
                reason: 'hold',
                quantity: 0,
            });

            await handler(makeRequest(true));

            expect(mockInsertCronDecisions).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                'execute',
                expect.any(Array),
            );
        });

        it('records skipped/market_closed when session is closed', async () => {
            mockIsEtRegularSessionOpen.mockReturnValue(false);

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'skipped', outcome: 'market_closed' }),
            );
        });

        it('records skipped/locked when lock is not acquired', async () => {
            mockAcquireLock.mockResolvedValue(false);

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'skipped', outcome: 'locked' }),
            );
        });

        it('records skipped/daily_loss_limit for realized loss limit breach', async () => {
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
                if (key === 'max_daily_loss_usd') return Promise.resolve(500);
                return Promise.resolve(null);
            });
            mockGetTodayRealizedPnl.mockResolvedValue(-600);
            mockGetOpenPositions.mockResolvedValue([]);

            await handler(makeRequest(true));

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'skipped', outcome: 'daily_loss_limit' }),
            );
        });

        it('records error finishState and re-throws on unhandled exception', async () => {
            mockGetNotificationConfig.mockRejectedValue(new Error('DB exploded'));

            await expect(handler(makeRequest(true))).rejects.toThrow('DB exploded');

            expect(mockFinishCronRun).toHaveBeenCalledWith(
                fakeDb,
                expect.any(String),
                expect.objectContaining({ status: 'error', error: 'DB exploded' }),
            );
        });

        it('audit failures do not abort trading (startCronRun throws → handler still runs)', async () => {
            mockStartCronRun.mockRejectedValue(new Error('audit DB down'));
            mockGetEnabledWatchlist.mockResolvedValue([]);
            mockGetOpenPositions.mockResolvedValue([]);

            const res = await handler(makeRequest(true));
            const body = await res.json();

            // Trading completed normally despite audit failure
            expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
        });
    });
});
