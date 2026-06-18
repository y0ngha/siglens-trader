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

const mockExecuteBuyOrder = vi.fn();
const mockExecuteSellOrder = vi.fn();
vi.mock('../../lib/trading/orders', () => ({
    executeBuyOrder: (...args: unknown[]) => mockExecuteBuyOrder(...args),
    executeSellOrder: (...args: unknown[]) => mockExecuteSellOrder(...args),
}));

const mockSendErrorEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/notification/email', () => ({
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
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
                key: 'stop_loss_percent',
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
                key: 'buy_threshold',
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

    it('rejects score_weights that is not an object', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: 'not_an_object',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('score_weights must be an object');
    });

    it('rejects score_weights that is an array', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: [1, 2, 3],
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('score_weights must be an object');
    });

    it('rejects score_weights with missing required key', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: 30, news: 20, options: 20, fundamental: 20 },
                // missing 'overall'
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('score_weights.overall must be a non-negative number');
    });

    it('rejects score_weights with negative value', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: -5, news: 20, options: 20, fundamental: 20, overall: 10 },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('score_weights.technical must be a non-negative number');
    });

    it('rejects score_weights with non-numeric value', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: 'high', news: 20, options: 20, fundamental: 20, overall: 10 },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('score_weights.technical must be a non-negative number');
    });

    it('accepts valid score_weights object', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: 30, news: 20, options: 20, fundamental: 20, overall: 10 },
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'score_weights', {
            technical: 30,
            news: 20,
            options: 20,
            fundamental: 20,
            overall: 10,
        });
    });

    it('rejects score_weights with unknown extra keys', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: {
                    technical: 30,
                    news: 20,
                    options: 20,
                    fundamental: 20,
                    overall: 10,
                    sentiment: 5,
                },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('unknown key');
        expect(data.error).toContain('sentiment');
    });

    it('rejects score_weights where all weights are zero (sum <= 0)', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'score_weights',
                value: { technical: 0, news: 0, options: 0, fundamental: 0, overall: 0 },
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('sum must be greater than 0');
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

    it('rejects string value for fixed_exit_enabled', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'fixed_exit_enabled',
                value: 'false',
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('must be a boolean');
    });

    // K1b — analysis_timeframe enum validation
    it.each(['5Min', '4Hour', '1Day', 'arbitrary'])(
        'rejects unsupported analysis_timeframe value %s',
        async (timeframe) => {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'analysis_timeframe',
                    value: timeframe,
                }),
            );
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({
                error: 'analysis_timeframe must be one of: 15Min, 30Min, 1Hour',
            });
        },
    );

    it('accepts supported analysis_timeframe values', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);
        for (const tf of ['15Min', '30Min', '1Hour']) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'config',
                    key: 'analysis_timeframe',
                    value: tf,
                }),
            );
            expect(res.status).toBe(200);
        }
        expect(mockSetConfigValue).toHaveBeenCalledTimes(3);
    });

    // -----------------------------------------------------------------------
    // T1 — buy_threshold / sell_threshold range validation (0–100)
    // -----------------------------------------------------------------------

    it('rejects buy_threshold above 100', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'buy_threshold',
                value: 150,
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('buy_threshold must be between 0 and 100');
    });

    it('rejects sell_threshold below 0', async () => {
        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'sell_threshold',
                value: -5,
            }),
        );
        // Negative values are caught by the generic 0–1,000,000 numeric guard
        // (which fires before the 0–100 range check), so we only assert 400 status
        expect(res.status).toBe(400);
    });

    it('accepts buy_threshold=70 and sell_threshold=30 (engine defaults)', async () => {
        mockSetConfigValue.mockResolvedValue(undefined);
        mockGetConfigValue.mockResolvedValue(30); // existing sell_threshold for buy check

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'buy_threshold',
                value: 70,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'buy_threshold', 70);
    });

    it('rejects buy_threshold <= sell_threshold (buy=20, existing sell=30)', async () => {
        mockGetConfigValue.mockResolvedValue(30); // existing sell_threshold

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'buy_threshold',
                value: 20,
            }),
        );
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('buy_threshold must be greater than sell_threshold');
    });

    // T2 — transition-scale: new-scale buy_threshold accepted when stored sell is old-scale
    it('accepts buy_threshold=70 when stored sell_threshold is old-scale (e.g. 30)', async () => {
        // Documents that the buy > sell cross-check reads the stored counterpart via getConfigValue.
        // A stored sell of 30 (valid 0–100 scale) satisfies buy(70) > sell(30).
        mockSetConfigValue.mockResolvedValue(undefined);
        mockGetConfigValue.mockResolvedValue(30); // stored sell_threshold counterpart

        const res = await handler(
            makeRequest('https://example.com/api/config', 'POST', {
                type: 'config',
                key: 'buy_threshold',
                value: 70,
            }),
        );
        expect(res.status).toBe(200);
        expect(mockSetConfigValue).toHaveBeenCalledWith(fakeDb, 'buy_threshold', 70);
    });
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
                mode: 'semi_auto',
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
        expect(data.error).toContain('Toss API 주문 실행 실패');
        // No phantom trade should be recorded
        expect(mockInsertTrade).not.toHaveBeenCalled();
        expect(mockOpenPosition).not.toHaveBeenCalled();
        // Order should be reverted for retry
        expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 52);
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
        );
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
        expect(mockInsertTrade).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                symbol: 'NVDA',
                side: 'sell',
                mode: 'semi_auto',
            }),
        );
        expect(mockClosePosition).toHaveBeenCalledWith(fakeDb, 99, 900);
        // Should not call Toss API in dry_run mode
        expect(mockExecuteSellOrder).not.toHaveBeenCalled();
    });

    it('returns 502 and reverts order to pending when Toss API throws', async () => {
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
        expect(data.error).toContain('Toss API 주문 실행 실패');
        // No trade should be recorded
        expect(mockInsertTrade).not.toHaveBeenCalled();
        expect(mockOpenPosition).not.toHaveBeenCalled();
        // Order should be reverted to pending for retry
        expect(mockRevertPendingOrder).toHaveBeenCalledWith(fakeDb, 86);
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
        expect(data.version).toBe('0.1.0');
        expect(typeof data.timestamp).toBe('string');
    });

    it('rejects non-GET methods', async () => {
        const res = await handler(makeRequest('https://example.com/api/health', 'POST'));
        expect(res.status).toBe(405);
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

        for (const analysisType of ['technical', 'news', 'options', 'fundamental', 'overall']) {
            const res = await handler(
                makeRequest('https://example.com/api/config', 'POST', {
                    type: 'analysis',
                    analysisType,
                    updates: { enabled: true },
                }),
            );
            expect(res.status).toBe(200);
        }
        expect(mockUpdateAnalysisConfig).toHaveBeenCalledTimes(5);
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
