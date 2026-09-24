import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
vi.mock('../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

const mockIsAuthenticated = vi.fn().mockResolvedValue(true);
vi.mock('../_lib/auth', () => ({
    isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...args),
}));

const mockCheckSchemaReadiness = vi.fn().mockResolvedValue({ ready: true });
vi.mock('../../lib/db/schema-readiness', () => ({
    checkSchemaReadiness: (...args: unknown[]) => mockCheckSchemaReadiness(...args),
}));

const mockExecuteBuyOrder = vi.fn();
const mockExecuteSellOrder = vi.fn();
const mockGetDryRunCashFlowUsd = vi.fn().mockResolvedValue(0);
const mockGetBuyingPower = vi.fn().mockResolvedValue(null);
// `getBuyingPower`만 갈아끼우고 나머지는 실제 모듈을 쓴다. 전체를 대체하면
// `getSellableQuantity`가 사라져 approve 경로가 조용히 다른 코드를 탄다.
vi.mock('../../lib/trading/account', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/trading/account')>()),
    getBuyingPower: (...args: unknown[]) => mockGetBuyingPower(...args),
}));

vi.mock('../../lib/trading/orders', () => ({
    executeBuyOrder: (...args: unknown[]) => mockExecuteBuyOrder(...args),
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockSendErrorEmail = vi.fn().mockResolvedValue(undefined);
const mockSendTradeExecutedEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/notification/email', () => ({
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
    sendTradeExecutedEmail: (...args: unknown[]) => mockSendTradeExecutedEmail(...args),
    buildTradeExecutedEmail: () => ({ subject: 's', html: '<p>h</p>' }),
    buildErrorEmail: () => ({ subject: 's', html: '<p>h</p>' }),
}));

const mockGetOpenPositions = vi.fn();
const mockGetConfigValue = vi.fn();
const mockGetTodayTradeCount = vi.fn();
const mockGetRecentTrades = vi.fn();
const mockGetLatestAnalysisResults = vi.fn();
const mockGetAllLatestAnalysisResults = vi.fn();
const mockGetAllConfig = vi.fn();
const mockGetAllWatchlist = vi.fn();
const mockGetAllAnalysisConfigs = vi.fn();
const mockGetNotificationConfig = vi.fn();
const mockEnqueueNotification = vi.fn().mockResolvedValue(undefined);
const mockSetConfigValue = vi.fn();
const mockAddToWatchlist = vi.fn();
const mockRemoveFromWatchlist = vi.fn();
const mockToggleWatchlistItem = vi.fn();
const mockUpdateAnalysisConfig = vi.fn();
const mockUpdateNotificationConfig = vi.fn();
const mockGetPendingOrders = vi.fn();
const mockGetPendingOrderById = vi.fn();
const mockApprovePendingOrder = vi.fn();
const mockRevertPendingOrder = vi.fn();
const mockRejectPendingOrder = vi.fn();
const mockInsertTrade = vi.fn();
const mockOpenPosition = vi.fn();
const mockGetOpenPositionBySymbol = vi.fn();
const mockClosePosition = vi.fn();
const mockDismissTrade = vi.fn();
const mockCreateOrderTracking = vi.fn().mockResolvedValue([]);
const mockUpdateOrderTracking = vi.fn().mockResolvedValue([]);
const mockAverageIntoPosition = vi.fn().mockResolvedValue(undefined);
const mockReducePositionQuantity = vi.fn().mockResolvedValue(true);
const mockGetCronRuns = vi.fn();
const mockGetCronDecisions = vi.fn();

vi.mock('../../lib/db/queries', () => ({
    getOpenPositions: (...args: unknown[]) => mockGetOpenPositions(...args),
    getDryRunCashFlowUsd: (...args: unknown[]) => mockGetDryRunCashFlowUsd(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    getTodayTradeCount: (...args: unknown[]) => mockGetTodayTradeCount(...args),
    getRecentTrades: (...args: unknown[]) => mockGetRecentTrades(...args),
    getLatestAnalysisResults: (...args: unknown[]) => mockGetLatestAnalysisResults(...args),
    getAllLatestAnalysisResults: (...args: unknown[]) => mockGetAllLatestAnalysisResults(...args),
    getAllConfig: (...args: unknown[]) => mockGetAllConfig(...args),
    getAllWatchlist: (...args: unknown[]) => mockGetAllWatchlist(...args),
    getAllAnalysisConfigs: (...args: unknown[]) => mockGetAllAnalysisConfigs(...args),
    getNotificationConfig: (...args: unknown[]) => mockGetNotificationConfig(...args),
    setConfigValue: (...args: unknown[]) => mockSetConfigValue(...args),
    addToWatchlist: (...args: unknown[]) => mockAddToWatchlist(...args),
    removeFromWatchlist: (...args: unknown[]) => mockRemoveFromWatchlist(...args),
    toggleWatchlistItem: (...args: unknown[]) => mockToggleWatchlistItem(...args),
    updateAnalysisConfig: (...args: unknown[]) => mockUpdateAnalysisConfig(...args),
    updateNotificationConfig: (...args: unknown[]) => mockUpdateNotificationConfig(...args),
    getPendingOrders: (...args: unknown[]) => mockGetPendingOrders(...args),
    getPendingOrderById: (...args: unknown[]) => mockGetPendingOrderById(...args),
    // 승인 경로가 리스크 차단기를 재확인한다. 기본값은 "여유 있음".
    getTodayRealizedPnl: () => Promise.resolve(0),
    getTodayInflightOrderCount: () => Promise.resolve(0),
    approvePendingOrder: (...args: unknown[]) => mockApprovePendingOrder(...args),
    revertPendingOrder: (...args: unknown[]) => mockRevertPendingOrder(...args),
    rejectPendingOrder: (...args: unknown[]) => mockRejectPendingOrder(...args),
    insertTrade: (...args: unknown[]) => mockInsertTrade(...args),
    openPosition: (...args: unknown[]) => mockOpenPosition(...args),
    getOpenPositionBySymbol: (...args: unknown[]) => mockGetOpenPositionBySymbol(...args),
    closePosition: (...args: unknown[]) => mockClosePosition(...args),
    dismissTrade: (...args: unknown[]) => mockDismissTrade(...args),
    createOrderTracking: (...args: unknown[]) => mockCreateOrderTracking(...args),
    updateOrderTracking: (...args: unknown[]) => mockUpdateOrderTracking(...args),
    averageIntoPosition: (...args: unknown[]) => mockAverageIntoPosition(...args),
    enqueueNotification: (...args: unknown[]) => mockEnqueueNotification(...args),
    reducePositionQuantity: (...args: unknown[]) => mockReducePositionQuantity(...args),
    getCronRuns: (...args: unknown[]) => mockGetCronRuns(...args),
    getCronDecisions: (...args: unknown[]) => mockGetCronDecisions(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = {
    fake: 'db',
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};

function makeRequest(url: string, method = 'GET', body?: unknown): Request {
    const init: RequestInit = { method };
    if (body) {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json' };
    }
    return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.resetAllMocks();
    mockIsAuthenticated.mockResolvedValue(true);
    mockGetDb.mockReturnValue(fakeDb);
    mockSendErrorEmail.mockResolvedValue(undefined);
    mockSendTradeExecutedEmail.mockResolvedValue(undefined);
    mockCheckSchemaReadiness.mockResolvedValue({ ready: true });
    // resetAllMocks clears this; the approve route reads it before doing anything.
    mockGetNotificationConfig.mockResolvedValue([
        {
            channel: 'email',
            enabled: true,
            target: 'ops@example.com',
            events: ['trade_executed', 'order_pending', 'stop_loss', 'error'],
        },
    ]);
    mockEnqueueNotification.mockResolvedValue(undefined);
    mockCreateOrderTracking.mockResolvedValue([]);
    mockUpdateOrderTracking.mockResolvedValue([]);
    mockRevertPendingOrder.mockResolvedValue(true);
});

describe('GET /api/status', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../status')).GET;
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/status', 'POST'));
        expect(res.status).toBe(405);
    });

    it('returns correct status shape', async () => {
        mockGetOpenPositions.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        mockGetConfigValue.mockResolvedValue('live');
        mockGetTodayTradeCount.mockResolvedValue(5);

        const res = await handler(makeRequest('https://example.com/api/status'));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({
            running: true,
            tradingMode: 'live',
            activePositions: 2,
            todayTrades: 5,
            tradingEnabled: 'live',
            maxTradesPerDay: 'live',
            // dry_run이 아니면 브로커 실잔고 경로. 조회 실패는 null이고 UI가 `—`로 그린다.
            cashBalance: null,
        });
    });

    describe('보유 현금', () => {
        it('dry_run은 예치금 + 체결 원장 순현금흐름을 낸다', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(
                    key === 'trading_mode' ? 'dry_run' : key === 'dry_run_cash_usd' ? 5000 : null,
                ),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetDryRunCashFlowUsd.mockResolvedValue(-472.8);

            const res = await handler(makeRequest('https://example.com/api/status'));

            expect((await res.json()).cashBalance).toBeCloseTo(4527.2);
            // 모의 계좌라 브로커를 부르지 않는다.
            expect(mockGetBuyingPower).not.toHaveBeenCalled();
        });

        it('dry_run 잔고는 0에서 멈춘다 — 음수 현금은 의미가 없다', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(
                    key === 'trading_mode' ? 'dry_run' : key === 'dry_run_cash_usd' ? 400 : null,
                ),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetDryRunCashFlowUsd.mockResolvedValue(-900);

            const res = await handler(makeRequest('https://example.com/api/status'));
            expect((await res.json()).cashBalance).toBe(0);
        });

        it('auto는 브로커 실잔고를 낸다', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(key === 'trading_mode' ? 'auto' : null),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetBuyingPower.mockResolvedValue(7777);

            const res = await handler(makeRequest('https://example.com/api/status'));

            expect(mockGetBuyingPower).toHaveBeenCalledWith('USD');
            expect((await res.json()).cashBalance).toBe(7777);
        });

        it('브로커 조회가 실패하면 null — 0으로 떨어뜨리지 않는다', async () => {
            // "못 읽었다"와 "현금이 없다"는 다른 상태다. 후자로 표시하면 운영자가
            // 있지도 않은 잔고 소진을 믿게 된다.
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(key === 'trading_mode' ? 'auto' : null),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetBuyingPower.mockRejectedValue(new Error('broker down'));

            const res = await handler(makeRequest('https://example.com/api/status'));
            expect(res.status).toBe(200);
            expect((await res.json()).cashBalance).toBeNull();
        });

        it('원장 조회가 실패해도 예치금으로 답한다', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(
                    key === 'trading_mode' ? 'dry_run' : key === 'dry_run_cash_usd' ? 3000 : null,
                ),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetDryRunCashFlowUsd.mockRejectedValue(new Error('db down'));

            const res = await handler(makeRequest('https://example.com/api/status'));
            expect((await res.json()).cashBalance).toBe(3000);
        });

        it('설정이 없으면 기본 예치금 $5,000', async () => {
            mockGetOpenPositions.mockResolvedValue([]);
            mockGetConfigValue.mockImplementation((_db: unknown, key: string) =>
                Promise.resolve(key === 'trading_mode' ? 'dry_run' : null),
            );
            mockGetTodayTradeCount.mockResolvedValue(0);
            mockGetDryRunCashFlowUsd.mockResolvedValue(0);

            const res = await handler(makeRequest('https://example.com/api/status'));
            expect((await res.json()).cashBalance).toBe(5000);
        });
    });

    it('defaults tradingMode to dry_run when not set', async () => {
        mockGetOpenPositions.mockResolvedValue([]);
        mockGetConfigValue.mockResolvedValue(null);
        mockGetTodayTradeCount.mockResolvedValue(0);

        const res = await handler(makeRequest('https://example.com/api/status'));
        const data = await res.json();
        expect(data.tradingMode).toBe('dry_run');
        expect(data.tradingEnabled).toBe(true);
        expect(data.maxTradesPerDay).toBe(20);
    });
});

describe('GET /api/positions', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../positions')).GET;
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/positions', 'POST'));
        expect(res.status).toBe(405);
    });

    it('returns open positions', async () => {
        const positions = [{ id: 1, symbol: 'AAPL', status: 'open' }];
        mockGetOpenPositions.mockResolvedValue(positions);

        const res = await handler(makeRequest('https://example.com/api/positions'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(positions);
    });
});

describe('GET /api/trades', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../trades')).GET;
    });

    it('rejects unsupported methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/trades', 'PUT'));
        expect(res.status).toBe(405);
    });

    it('returns recent trades with limit 100', async () => {
        const tradeList = [{ id: 1, symbol: 'TSLA' }];
        mockGetRecentTrades.mockResolvedValue(tradeList);

        const res = await handler(makeRequest('https://example.com/api/trades'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(tradeList);
        expect(mockGetRecentTrades).toHaveBeenCalledWith(fakeDb, 100);
    });
});

describe('POST /api/trades (dismiss)', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../trades')).GET;
    });

    it('dismisses a trade by id', async () => {
        mockDismissTrade.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/trades', 'POST', { action: 'dismiss', id: 42 }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(mockDismissTrade).toHaveBeenCalledWith(fakeDb, 42);
    });

    it('rejects invalid action', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/trades', 'POST', { action: 'unknown', id: 1 }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects missing id', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/trades', 'POST', { action: 'dismiss' }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects invalid JSON body', async () => {
        const req = new Request('https://example.com/api/trades', {
            method: 'POST',
            body: 'not json',
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
    });
});

describe('GET /api/analysis', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../analysis')).GET;
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/analysis', 'DELETE'));
        expect(res.status).toBe(405);
    });

    it('returns all latest results when no symbol provided', async () => {
        const all = [
            {
                id: 1,
                symbol: 'NVDA',
                analysisType: 'technical',
                result: {},
                analyzedAt: '2026-06-15T19:00:00Z',
            },
            {
                id: 2,
                symbol: 'NVDA',
                analysisType: 'news',
                result: {},
                analyzedAt: '2026-06-15T18:00:00Z',
            },
        ];
        mockGetAllLatestAnalysisResults.mockResolvedValueOnce(all);

        const res = await handler(makeRequest('https://example.com/api/analysis'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(all);
        expect(mockGetAllLatestAnalysisResults).toHaveBeenCalled();
        expect(mockGetLatestAnalysisResults).not.toHaveBeenCalled();
    });

    it('returns analysis results for symbol', async () => {
        const results = [{ id: 1, symbol: 'AAPL', analysisType: 'technical' }];
        mockGetLatestAnalysisResults.mockResolvedValue(results);

        const res = await handler(makeRequest('https://example.com/api/analysis?symbol=AAPL'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(results);
        expect(mockGetLatestAnalysisResults).toHaveBeenCalledWith(fakeDb, 'AAPL');
        expect(mockGetAllLatestAnalysisResults).not.toHaveBeenCalled();
    });

    it('미인증 → 403', async () => {
        mockIsAuthenticated.mockResolvedValueOnce(false);
        const res = await handler(makeRequest('https://example.com/api/analysis'));
        expect(res.status).toBe(403);
    });
});

describe('GET /api/config', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../config')).GET;
    });

    it('rejects unsupported methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/config', 'DELETE'));
        expect(res.status).toBe(405);
    });

    it('returns all config sections', async () => {
        mockGetAllConfig.mockResolvedValue([{ key: 'trading_mode', value: 'live' }]);
        mockGetAllWatchlist.mockResolvedValue([{ symbol: 'AAPL' }]);
        mockGetAllAnalysisConfigs.mockResolvedValue([{ analysisType: 'technical' }]);
        mockGetNotificationConfig.mockResolvedValue([{ channel: 'email' }]);

        const res = await handler(makeRequest('https://example.com/api/config'));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({
            config: [{ key: 'trading_mode', value: 'live' }],
            watchlist: [{ symbol: 'AAPL' }],
            analysis: [{ analysisType: 'technical' }],
            notification: [{ channel: 'email' }],
        });
    });
});

describe('POST /api/config', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../config')).GET;
    });

    it('rejects invalid JSON', async () => {
        const req = new Request('https://example.com/api/config', {
            method: 'POST',
            body: 'not json',
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
    });

    it('rejects body without type field', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', { key: 'foo' }),
        );
        expect(res.status).toBe(400);
    });

    it('handles config type', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_mode',
                value: 'dry_run',
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'trading_mode', 'dry_run');
    });

    it('rejects config type without key', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                value: 'test',
            }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects non-numeric value for numeric config keys', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'max_position_size',
                value: 'not_a_number',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a number between');
    });

    it('rejects negative value for numeric config keys', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'max_daily_loss_usd',
                value: -5,
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a number between');
    });

    it('rejects Infinity for numeric config keys', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'max_position_size',
                value: Infinity,
            }),
        );
        expect(res.status).toBe(400);
    });

    it('accepts valid numeric config value', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'max_position_size',
                value: 2000,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'max_position_size', 2000);
    });

    it('accepts valid trading_mode values', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        for (const mode of ['dry_run', 'semi_auto', 'auto']) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'trading_mode',
                    value: mode,
                }),
            );
            expect(res.status).toBe(200);
        }
        expect(mockSetConfigValue).toHaveBeenCalledTimes(3);
    });

    it('rejects invalid trading_mode value', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_mode',
                value: 'live',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('trading_mode must be one of');
    });

    it('rejects empty string for trading_mode', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_mode',
                value: '',
            }),
        );
        expect(res.status).toBe(400);
    });

    it('accepts a valid execute_interval_min', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'execute_interval_min',
                value: 5,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'execute_interval_min', 5);
    });

    it('rejects an execute_interval_min outside the allowed set', async () => {
        // 60의 약수가 아니면 시(hour) 경계에서 주기가 어긋난다. 7·12는 그래서 거부다.
        for (const value of [7, 12, 0, -5, 90, '10', null, 10.5]) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'execute_interval_min',
                    value,
                }),
            );
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('execute_interval_min must be one of');
        }
    });

    it('accepts dry_run_cash_usd as a numeric key', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        for (const value of [0, 5000, 100000]) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'dry_run_cash_usd',
                    value,
                }),
            );
            expect(res.status).toBe(200);
        }
    });

    it('rejects a non-numeric or out-of-range dry_run_cash_usd', async () => {
        for (const value of [-1, 1_000_001, 'lots', null]) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'dry_run_cash_usd',
                    value,
                }),
            );
            expect(res.status).toBe(400);
        }
    });

    it('handles watchlist add', async () => {
        mockGetAllWatchlist.mockResolvedValue([{ id: 1, symbol: 'NVDA' }]);
        mockAddToWatchlist.mockResolvedValue([{ id: 2, symbol: 'AAPL' }]);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'add',
                symbol: 'AAPL',
                companyName: 'Apple Inc.',
            }),
        );
        expect(res.status).toBe(200);
        expect(mockAddToWatchlist).toHaveBeenCalledWith(fakeDb, 'AAPL', 'Apple Inc.');
    });

    it('watchlist cap is 30 — AI no longer runs per symbol, so the old cap of 5 is gone', async () => {
        mockGetAllWatchlist.mockResolvedValue(Array.from({ length: 29 }, (_, i) => ({ id: i })));
        mockAddToWatchlist.mockResolvedValue([{ id: 99, symbol: 'SPY' }]);
        const ok = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'add',
                symbol: 'SPY',
                companyName: 'SPDR S&P 500 ETF',
            }),
        );
        expect(ok.status).toBe(200);
        mockGetAllWatchlist.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ id: i })));
        const full = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'add',
                symbol: 'QQQ',
                companyName: 'Invesco QQQ',
            }),
        );
        expect(full.status).toBe(400);
        expect(await full.json()).toEqual({ error: '감시 종목은 최대 30개까지 설정 가능합니다' });
    });

    it('handles watchlist remove', async () => {
        mockRemoveFromWatchlist.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'remove',
                id: 5,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockRemoveFromWatchlist).toHaveBeenCalledWith(fakeDb, 5);
    });

    it('handles watchlist toggle', async () => {
        mockToggleWatchlistItem.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'toggle',
                id: 3,
                enabled: false,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockToggleWatchlistItem).toHaveBeenCalledWith(fakeDb, 3, false);
    });

    it('rejects invalid watchlist action', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'watchlist',
                action: 'invalid',
            }),
        );
        expect(res.status).toBe(400);
    });

    it('handles analysis config update', async () => {
        mockUpdateAnalysisConfig.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'analysis',
                analysisType: 'technical',
                updates: { enabled: true, modelId: 'claude-sonnet-4-20250514' },
            }),
        );
        expect(res.status).toBe(200);
        expect(mockUpdateAnalysisConfig).toHaveBeenCalledWith(fakeDb, 'technical', {
            enabled: true,
            modelId: 'claude-sonnet-4-20250514',
        });
    });

    it('handles notification config update', async () => {
        mockUpdateNotificationConfig.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'notification',
                channel: 'email',
                updates: { enabled: true, target: 'user@example.com' },
            }),
        );
        expect(res.status).toBe(200);
        expect(mockUpdateNotificationConfig).toHaveBeenCalledWith(fakeDb, 'email', {
            enabled: true,
            target: 'user@example.com',
        });
    });

    it('rejects unknown type', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', { type: 'unknown' }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects a negative congress weight', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: 8, news: 6, options: 5, fundamental: 4, congress: -1 },
            }),
        );
        expect(res.status).toBe(400);
    });

    // K1 — Boolean config key validation (kill-switch integrity)
    it('rejects string "false" for trading_enabled (kill-switch integrity)', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_enabled',
                value: 'false',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a boolean');
    });

    it('rejects string "true" for trading_enabled', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_enabled',
                value: 'true',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a boolean');
    });

    it('rejects numeric 0 for trading_enabled', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_enabled',
                value: 0,
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a boolean');
    });

    it('accepts boolean true for trading_enabled', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_enabled',
                value: true,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'trading_enabled', true);
    });

    it('accepts boolean false for trading_enabled', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'trading_enabled',
                value: false,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'trading_enabled', false);
    });

    // 폐기 키(종합 점수·컨플루언스·진입 창·고정 청산·분석 타임프레임)는 이제 모르는 키다 — 스펙 §6.
    it.each([
        'buy_threshold',
        'sell_threshold',
        'score_weights',
        'confluence_min',
        'entry_window',
        'entry_cooldown_min',
        'min_rr',
        'min_stop_room_pct',
        'fixed_exit_enabled',
        'stop_loss_percent',
        'take_profit_percent',
        'analysis_timeframe',
    ])('rejects the retired key %s as unknown', async (key) => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key,
                value: 1,
            }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: `Unknown config key: "${key}"` });
    });

    it.each([
        ['mr_rsi_entry', 1],
        ['mr_rsi_entry', 50],
        ['mr_max_hold_days', 1],
        ['mr_max_hold_days', 60],
        ['mr_stop_atr', 0],
        ['mr_stop_atr', 20],
        ['dry_run_cost_bps', 0],
        ['dry_run_cost_bps', 100],
    ] as const)('accepts strategy key %s = %s (range edge)', async (key, value) => {
        mockSetConfigValue.mockResolvedValue(undefined);
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', { type: 'config', key, value }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, key, value);
    });

    it.each([
        ['mr_rsi_entry', 0, 'mr_rsi_entry must be between 1 and 50'],
        ['mr_rsi_entry', 51, 'mr_rsi_entry must be between 1 and 50'],
        ['mr_max_hold_days', 0, 'mr_max_hold_days must be an integer between 1 and 60'],
        ['mr_max_hold_days', 5.5, 'mr_max_hold_days must be an integer between 1 and 60'],
        ['mr_stop_atr', 21, 'mr_stop_atr must be between 0 and 20'],
        ['dry_run_cost_bps', 101, 'dry_run_cost_bps must be between 0 and 100'],
    ] as const)('rejects strategy key %s = %s', async (key, value, error) => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', { type: 'config', key, value }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
    });

    it('mr_regime_filter must be a boolean', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);
        const bad = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'mr_regime_filter',
                value: 'true',
            }),
        );
        expect(bad.status).toBe(400);
        const ok = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'mr_regime_filter',
                value: false,
            }),
        );
        expect(ok.status).toBe(200);
    });

    // -----------------------------------------------------------------------
    // T1 — buy_threshold / sell_threshold range validation (0–100)
    // -----------------------------------------------------------------------

    // T2 — transition-scale: new-scale buy_threshold accepted when stored sell is old-scale
});

describe('GET /api/pending', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../pending')).GET;
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/pending', 'POST'));
        expect(res.status).toBe(405);
    });

    it('returns pending orders', async () => {
        const orders = [{ id: 1, symbol: 'AAPL', status: 'pending' }];
        mockGetPendingOrders.mockResolvedValue(orders);

        const res = await handler(makeRequest('https://example.com/api/pending'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(orders);
    });
});

describe('POST /api/approve/[id]', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../approve/[id]')).POST;
    });

    it('rejects non-POST methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/approve/1', 'GET'));
        expect(res.status).toBe(405);
    });

    it('rejects invalid ID', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/approve/abc', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects invalid JSON body', async () => {
        const req = new Request('https://example.com/api/approve/1', {
            method: 'POST',
            body: 'not json',
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
    });

    it('rejects missing action', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/approve/1', 'POST', { foo: 'bar' }),
        );
        expect(res.status).toBe(400);
    });

    it('rejects invalid action value', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/approve/1', 'POST', { action: 'cancel' }),
        );
        expect(res.status).toBe(400);
    });

    it('approves a pending order (dry_run mode)', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 42,
            symbol: 'AAPL',
            side: 'buy',
            quantity: 10,
            priceLimit: '150.00',
            analysisSummary: 'Strong buy signal',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);
        mockGetConfigValue.mockResolvedValue('dry_run');
        mockInsertTrade.mockResolvedValue([{}]);
        mockOpenPosition.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/approve/42', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ success: true, action: 'approve', id: 42 });
        expect(mockGetPendingOrderById).toHaveBeenCalledWith(fakeDb, 42);
        expect(mockApprovePendingOrder).toHaveBeenCalledWith(fakeDb, 42);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'AAPL',
                side: 'buy',
                // dry_run 승인은 dry_run으로 기록된다 (실계좌 차단기 오염 방지).
                mode: 'dry_run',
            }),
        );
        expect(mockOpenPosition).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
            }),
        );
        // Should not call Toss API in dry_run mode
        expect(mockExecuteBuyOrder).not.toHaveBeenCalled();
    });

    it('calls Toss API in auto mode and uses filled price', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 50,
            symbol: 'NVDA',
            side: 'buy',
            quantity: 5,
            priceLimit: '900.00',
            analysisSummary: 'Auto buy',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);
        mockGetConfigValue.mockResolvedValue('auto');
        mockExecuteBuyOrder.mockResolvedValue({
            orderId: 'T123',
            clientOrderId: 'approve-50',
            status: 'filled',
            avgFilledPrice: 895.5,
            filledQuantity: 5,
        });
        mockInsertTrade.mockResolvedValue([{}]);
        mockOpenPosition.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/approve/50', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(200);
        expect(mockExecuteBuyOrder).toHaveBeenCalledWith('NVDA', 5, 'approve-50');
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'NVDA',
                price: 895.5,
                mode: 'auto',
            }),
        );
        expect(mockOpenPosition).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ avgPrice: 895.5 }),
        );
    });

    it('returns 422 when Toss API rejects the order', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 51,
            symbol: 'TSLA',
            side: 'sell',
            quantity: 3,
            priceLimit: '250.00',
            analysisSummary: 'Sell signal',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetConfigValue.mockResolvedValue('auto');
        mockExecuteSellOrder.mockResolvedValue({
            orderId: '',
            clientOrderId: 'approve-51',
            status: 'rejected',
            rejectReason: 'insufficient-balance',
        });

        const res = await handler(
            makeRequest('https://example.com/api/approve/51', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(422);
        const data = await res.json();
        expect(data.error).toContain('insufficient-balance');
    });

    it('returns 502 and does not record trade when Toss API throws', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 52,
            symbol: 'META',
            side: 'buy',
            quantity: 2,
            priceLimit: '520.00',
            analysisSummary: 'Fallback test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockRevertPendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);
        mockGetConfigValue.mockResolvedValue('auto');
        mockExecuteBuyOrder.mockRejectedValue(new Error('TOSS_APP_KEY is required'));

        const res = await handler(
            makeRequest('https://example.com/api/approve/52', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).toContain('결과 미확정');
        // No phantom trade should be recorded
        expect(mockInsertTrade).not.toHaveBeenCalled();
        expect(mockOpenPosition).not.toHaveBeenCalled();
        // 결말 미확정이므로 되살리지 않는다 (재승인 = 두 번째 실주문 위험).
        expect(mockRevertPendingOrder).not.toHaveBeenCalled();
    });

    it('averages into existing position for duplicate buy', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 60,
            symbol: 'AAPL',
            side: 'buy',
            quantity: 3,
            priceLimit: '195.00',
            analysisSummary: 'Additional buy',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue({
            id: 1,
            symbol: 'AAPL',
            status: 'open',
        });
        mockInsertTrade.mockResolvedValue([{}]);

        const res = await handler(
            makeRequest('https://example.com/api/approve/60', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                reason: expect.stringContaining('기존 포지션에 추가'),
            }),
        );
        // Should average into existing position, not open new one
        expect(mockAverageIntoPosition).toHaveBeenCalledWith(fakeDb, 1, 3, 195);
        expect(mockOpenPosition).not.toHaveBeenCalled();
    });

    it('returns 500 and sends error email when insertTrade fails after approve', async () => {
        // Pin the clock outside quiet hours (06:00Z = 15:00 KST): inside 00:00-09:59 KST the
        // dispatcher queues for the morning digest instead of sending, which would make this
        // assertion pass or fail depending on what time the suite happens to run.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-25T06:00:00.000Z'));
        mockGetPendingOrderById.mockResolvedValue({
            id: 70,
            symbol: 'GOOG',
            side: 'buy',
            quantity: 1,
            priceLimit: '180.00',
            analysisSummary: 'Partial failure test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);
        mockGetConfigValue.mockResolvedValue('dry_run');
        mockInsertTrade.mockRejectedValue(new Error('DB write failed'));
        mockRevertPendingOrder.mockResolvedValue(true);
        mockSendErrorEmail.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/approve/70', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toBe('Trade recording failed after approval');
        expect(mockSendErrorEmail).toHaveBeenCalledWith(
            expect.stringContaining('GOOG'),
            expect.stringContaining('DB write failed'),
            // The dispatcher forwards the dashboard-configured recipient.
            'ops@example.com',
        );
        vi.useRealTimers();
    });

    it('returns 404 when order not found', async () => {
        mockGetPendingOrderById.mockResolvedValue(null);

        const res = await handler(
            makeRequest('https://example.com/api/approve/999', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(404);
    });

    it('returns 409 when double-approve (approvePendingOrder returns false)', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 80,
            symbol: 'AAPL',
            side: 'buy',
            quantity: 5,
            priceLimit: '150.00',
            analysisSummary: 'Double approve test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(false);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);

        const res = await handler(
            makeRequest('https://example.com/api/approve/80', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toBe('Order was already processed');
    });

    it('returns 410 when order has expired', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 81,
            symbol: 'TSLA',
            side: 'buy',
            quantity: 3,
            priceLimit: '200.00',
            analysisSummary: 'Expired order test',
            status: 'pending',
            expiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
        });

        const res = await handler(
            makeRequest('https://example.com/api/approve/81', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(410);
        const data = await res.json();
        expect(data.error).toBe('Order has expired');
    });

    it('returns 409 when order status is not pending', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 82,
            symbol: 'GOOG',
            side: 'buy',
            quantity: 2,
            priceLimit: '170.00',
            analysisSummary: 'Already processed test',
            status: 'approved', // not 'pending'
            expiresAt: new Date(Date.now() + 60_000),
        });

        const res = await handler(
            makeRequest('https://example.com/api/approve/82', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toBe('Order is no longer pending');
    });

    it('returns 400 when priceLimit is null/0', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 83,
            symbol: 'AMZN',
            side: 'buy',
            quantity: 1,
            priceLimit: null,
            analysisSummary: 'No price test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });

        const res = await handler(
            makeRequest('https://example.com/api/approve/83', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Order has no valid price limit');
    });

    it('returns 400 when priceLimit is 0', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 84,
            symbol: 'AMZN',
            side: 'buy',
            quantity: 1,
            priceLimit: '0',
            analysisSummary: 'Zero price test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });

        const res = await handler(
            makeRequest('https://example.com/api/approve/84', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Order has no valid price limit');
    });

    it('sell-side approve closes position in dry_run mode', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 85,
            symbol: 'NVDA',
            side: 'sell',
            quantity: 10,
            priceLimit: '900.00',
            analysisSummary: 'Sell approve test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockGetConfigValue.mockResolvedValue('dry_run');
        mockInsertTrade.mockResolvedValue([{}]);
        mockGetOpenPositionBySymbol.mockResolvedValue({
            id: 99,
            symbol: 'NVDA',
            quantity: 10,
            status: 'open',
        });
        mockClosePosition.mockResolvedValue(true);

        const res = await handler(
            makeRequest('https://example.com/api/approve/85', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(200);
        // dry_run 승인은 dry_run으로 기록된다 — 종전에는 'semi_auto' 하드코딩이라
        // 시뮬레이션 손익이 실계좌 일일 손실 차단기에 섞였다.
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'NVDA',
                side: 'sell',
                mode: 'dry_run',
            }),
        );
        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 99, 900);
        // Should not call Toss API in dry_run mode
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
    });

    it('returns 502 and does NOT revert the order when the Toss call outcome is unknown', async () => {
        mockGetPendingOrderById.mockResolvedValue({
            id: 86,
            symbol: 'META',
            side: 'buy',
            quantity: 2,
            priceLimit: '520.00',
            analysisSummary: 'Toss failure test',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
        });
        mockApprovePendingOrder.mockResolvedValue(true);
        mockRevertPendingOrder.mockResolvedValue(true);
        mockGetOpenPositionBySymbol.mockResolvedValue(null);
        mockGetConfigValue.mockResolvedValue('auto');
        mockExecuteBuyOrder.mockRejectedValue(new Error('TOSS_APP_KEY is required'));

        const res = await handler(
            makeRequest('https://example.com/api/approve/86', 'POST', { action: 'approve' }),
        );
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).toContain('결과 미확정');
        // No trade should be recorded
        expect(mockInsertTrade).not.toHaveBeenCalled();
        expect(mockOpenPosition).not.toHaveBeenCalled();
        // 되살리지 않는다 — 재승인은 토스 멱등키(10분) 밖에서 두 번째 실주문이 된다.
        expect(mockRevertPendingOrder).not.toHaveBeenCalled();
    });

    it('rejects a pending order', async () => {
        mockRejectPendingOrder.mockResolvedValue(true);

        const res = await handler(
            makeRequest('https://example.com/api/approve/7', 'POST', { action: 'reject' }),
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ success: true, action: 'reject', id: 7 });
        expect(mockRejectPendingOrder).toHaveBeenCalledWith(fakeDb, 7);
    });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../health')).GET;
    });

    it('returns 200 with status ok', async () => {
        const res = await handler(makeRequest('https://example.com/api/health'));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(typeof data.timestamp).toBe('string');
    });

    it('version은 이미지 태그(APP_VERSION)를 그대로 낸다', async () => {
        // 하드코딩된 '0.1.0'은 실제 배포 버전과 무관해 "어떤 빌드가 도는지"를 말해주지
        // 못했다 — 배포 검증이 "포트가 열렸다" 이상을 확인하지 못한 이유의 절반.
        const original = process.env.APP_VERSION;
        process.env.APP_VERSION = 'v9.9.9-test';
        try {
            const res = await handler(makeRequest('https://example.com/api/health'));
            expect((await res.json()).version).toBe('v9.9.9-test');
        } finally {
            if (original === undefined) delete process.env.APP_VERSION;
            else process.env.APP_VERSION = original;
        }
    });

    it('APP_VERSION이 없으면 unknown', async () => {
        const original = process.env.APP_VERSION;
        delete process.env.APP_VERSION;
        try {
            const res = await handler(makeRequest('https://example.com/api/health'));
            expect((await res.json()).version).toBe('unknown');
        } finally {
            if (original !== undefined) process.env.APP_VERSION = original;
        }
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/health', 'POST'));
        expect(res.status).toBe(405);
    });

    it('deep 검사는 인증을 요구한다 — 정합성 알림에 심볼·주문키가 들어간다', async () => {
        mockIsAuthenticated.mockResolvedValue(false);

        const res = await handler(makeRequest('https://example.com/api/health?deep=true'));

        expect(res.status).toBe(403);
    });

    it('얕은 헬스체크는 인증 없이 통과한다 — 업타임 모니터링용', async () => {
        mockIsAuthenticated.mockResolvedValue(false);

        const res = await handler(makeRequest('https://example.com/api/health'));

        expect(res.status).toBe(200);
    });

    it('ready=true 스키마 준비 확인은 인증 없이 통과한다 — deploy.sh가 폴링', async () => {
        mockIsAuthenticated.mockResolvedValue(false);
        mockCheckSchemaReadiness.mockResolvedValue({ ready: true });

        const res = await handler(makeRequest('https://example.com/api/health?ready=true'));

        expect(res.status).toBe(200);
        expect((await res.json()).ready).toBe(true);
        expect(mockIsAuthenticated).not.toHaveBeenCalled();
    });

    it('스키마 불일치(42703)면 ready=true가 503으로 배포 실패를 알린다', async () => {
        mockCheckSchemaReadiness.mockResolvedValue({
            ready: false,
            error: 'schema mismatch (42703): column "timeframe" does not exist',
        });

        const res = await handler(makeRequest('https://example.com/api/health?ready=true'));

        expect(res.status).toBe(503);
        const data = await res.json();
        expect(data.ready).toBe(false);
        expect(data.status).toBe('degraded');
        expect(data.error).toContain('42703');
    });

    it('getDb() 자체가 던져도(DATABASE_URL 미설정 등) 503으로 죽는다', async () => {
        mockGetDb.mockImplementation(() => {
            throw new Error('DATABASE_URL environment variable is required');
        });

        const res = await handler(makeRequest('https://example.com/api/health?ready=true'));

        expect(res.status).toBe(503);
    });
});

// ---------------------------------------------------------------------------
// Analysis type allowlist
// ---------------------------------------------------------------------------

describe('POST /api/config — analysis type allowlist', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../config')).GET;
    });

    it('rejects unknown analysis type', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'analysis',
                analysisType: 'astrology',
                updates: { enabled: true },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Unknown analysis type');
    });

    it('accepts valid analysis types', async () => {
        mockUpdateAnalysisConfig.mockResolvedValue(undefined);

        for (const analysisType of ['technical', 'news', 'fundamental', 'entry_review']) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'analysis',
                    analysisType,
                    updates: { enabled: true },
                }),
            );
            expect(res.status).toBe(200);
        }
        expect(mockUpdateAnalysisConfig).toHaveBeenCalledTimes(4);
    });

    it('rejects the retired types (options, congress, trade_gate)', async () => {
        for (const analysisType of ['options', 'congress', 'trade_gate']) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'analysis',
                    analysisType,
                    updates: { enabled: true },
                }),
            );
            expect(res.status).toBe(400);
        }
    });
});

// ---------------------------------------------------------------------------
// Notification channel allowlist
// ---------------------------------------------------------------------------

describe('POST /api/config — notification channel allowlist', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../config')).GET;
    });

    it('rejects unknown notification channel', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'notification',
                channel: 'sms',
                updates: { enabled: true },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Unknown notification channel');
    });

    it('accepts email channel', async () => {
        mockUpdateNotificationConfig.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'notification',
                channel: 'email',
                updates: { enabled: true },
            }),
        );
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// GET /api/cron-runs
// ---------------------------------------------------------------------------

describe('GET /api/cron-runs', () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
        handler = (await import('../cron-runs')).GET;
    });

    it('returns 403 when not authenticated', async () => {
        mockIsAuthenticated.mockResolvedValue(false);

        const res = await handler(makeRequest('https://example.com/api/cron-runs'));
        expect(res.status).toBe(403);
    });

    it('returns 405 on non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/cron-runs', 'POST'));
        expect(res.status).toBe(405);
    });

    it('returns runs list when authed and no runId', async () => {
        const runs = [{ id: 1, runId: 'execute-123', cronType: 'execute', status: 'completed' }];
        mockGetCronRuns.mockResolvedValue(runs);

        const res = await handler(makeRequest('https://example.com/api/cron-runs'));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ runs });
        expect(mockGetCronRuns).toHaveBeenCalledWith(fakeDb, {
            cronType: undefined,
            status: undefined,
            from: undefined,
            to: undefined,
            limit: undefined,
        });
    });

    it('passes valid type filter to getCronRuns', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?type=technical'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ cronType: 'technical' }),
        );
    });

    it('accepts the review cron type (AI entry review runs)', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?type=review'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ cronType: 'review' }),
        );
    });

    it('ignores unknown type filter (does not 400)', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?type=astrology'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ cronType: undefined }),
        );
    });

    it('passes valid status filter to getCronRuns', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?status=error'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ status: 'error' }),
        );
    });

    it('ignores unknown status filter (does not 400)', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(
            makeRequest('https://example.com/api/cron-runs?status=unknown_status'),
        );
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ status: undefined }),
        );
    });

    it('parses valid from ISO date into Date object', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(
            makeRequest('https://example.com/api/cron-runs?from=2026-06-12T13:00:00.000Z'),
        );
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ from: new Date('2026-06-12T13:00:00.000Z') }),
        );
    });

    it('ignores invalid from date (passes undefined)', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?from=not-a-date'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ from: undefined }),
        );
    });

    it('passes valid limit to getCronRuns', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?limit=50'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ limit: 50 }),
        );
    });

    it('ignores NaN limit (limit=abc) — passes limit: undefined', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?limit=abc'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ limit: undefined }),
        );
    });

    it('ignores negative limit (limit=-5) — passes limit: undefined', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?limit=-5'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ limit: undefined }),
        );
    });

    it('ignores zero limit (limit=0) — passes limit: undefined', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?limit=0'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ limit: undefined }),
        );
    });

    it('truncates float limit (limit=10.9) — passes limit: 10', async () => {
        mockGetCronRuns.mockResolvedValue([]);

        const res = await handler(makeRequest('https://example.com/api/cron-runs?limit=10.9'));
        expect(res.status).toBe(200);
        expect(mockGetCronRuns).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ limit: 10 }),
        );
    });

    it('returns decisions when runId param present', async () => {
        const decisions = [{ id: 1, runId: 'execute-123', action: 'buy', executed: true }];
        mockGetCronDecisions.mockResolvedValue(decisions);

        const res = await handler(
            makeRequest('https://example.com/api/cron-runs?runId=execute-123'),
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ decisions });
        expect(mockGetCronDecisions).toHaveBeenCalledWith(fakeDb, 'execute-123');
        // getCronRuns should NOT be called when runId is present
        expect(mockGetCronRuns).not.toHaveBeenCalled();
    });
});
