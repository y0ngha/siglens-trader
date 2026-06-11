import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { orderTracking } from '../schema';
import {
    getEnabledWatchlist,
    getAllWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlistItem,
    getAnalysisConfig,
    getAllAnalysisConfigs,
    updateAnalysisConfig,
    getConfigValue,
    setConfigValue,
    getAllConfig,
    saveAnalysisResult,
    getLatestAnalysisResult,
    getLatestAnalysisResults,
    getOpenPositions,
    getOpenPositionBySymbol,
    openPosition,
    closePosition,
    reducePositionQuantity,
    averageIntoPosition,
    insertTrade,
    getRecentTrades,
    getTodayTradeCount,
    getTodayRealizedPnl,
    insertPendingOrder,
    getPendingOrders,
    expireOldPendingOrders,
    approvePendingOrder,
    rejectPendingOrder,
    getNotificationConfig,
    updateNotificationConfig,
    createOrderTracking,
    updateOrderTracking,
    getPendingSubmittedOrders,
} from '../queries';
import type { Db } from '../index';

/**
 * Creates a mock Drizzle db instance with chainable builder pattern.
 * Each chain terminates differently depending on the query type:
 * - select chains end at .limit() or .from()/.where()/.orderBy() (returns array)
 * - insert chains end at .returning() or .onConflictDoUpdate()/.onConflictDoNothing()
 * - update chains end at .where()
 * - delete chains end at .where()
 */
function createMockDb(resolvedValue: unknown = []) {
    const chainMethods = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(resolvedValue),
        values: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(resolvedValue),
        onConflictDoNothing: vi.fn().mockResolvedValue(resolvedValue),
        onConflictDoUpdate: vi.fn().mockResolvedValue(resolvedValue),
    };

    // For queries that don't call .limit() or .returning(), the chain itself
    // resolves as a thenable (Drizzle's query builders are PromiseLike).
    // We make .from(), .where(), .orderBy() also resolve when awaited.
    const makeThennable = (obj: Record<string, unknown>) => {
        (obj as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve(resolvedValue).then(resolve);
        return obj;
    };

    makeThennable(chainMethods);

    const db = {
        select: vi.fn().mockReturnValue(chainMethods),
        insert: vi.fn().mockReturnValue(chainMethods),
        update: vi.fn().mockReturnValue(chainMethods),
        delete: vi.fn().mockReturnValue(chainMethods),
        execute: vi.fn().mockResolvedValue(resolvedValue),
        _chain: chainMethods,
    };

    return db as unknown as Db & { _chain: typeof chainMethods; execute: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

describe('Watchlist queries', () => {
    let db: ReturnType<typeof createMockDb>;

    beforeEach(() => {
        db = createMockDb([]);
    });

    describe('getEnabledWatchlist', () => {
        it('calls select().from(watchlist).where(enabled=true)', async () => {
            const mockRows = [{ id: 1, symbol: 'AAPL', enabled: true }];
            db = createMockDb(mockRows);

            const result = await getEnabledWatchlist(db as unknown as Db);

            expect(db._chain.from).toHaveBeenCalled();
            expect(db._chain.where).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('getAllWatchlist', () => {
        it('calls select().from(watchlist) without where', async () => {
            const mockRows = [
                { id: 1, symbol: 'AAPL' },
                { id: 2, symbol: 'MSFT' },
            ];
            db = createMockDb(mockRows);

            const result = await getAllWatchlist(db as unknown as Db);

            expect(
                (db as unknown as { select: ReturnType<typeof vi.fn> }).select,
            ).toHaveBeenCalled();
            expect(db._chain.from).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('addToWatchlist', () => {
        it('calls insert().values().returning() with correct params', async () => {
            const mockReturned = [{ id: 3, symbol: 'TSLA', companyName: 'Tesla' }];
            db = createMockDb(mockReturned);

            const result = await addToWatchlist(db as unknown as Db, 'TSLA', 'Tesla');

            expect(
                (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
            ).toHaveBeenCalled();
            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'TSLA',
                companyName: 'Tesla',
            });
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });
    });

    describe('removeFromWatchlist', () => {
        it('calls delete().where() with correct id', async () => {
            await removeFromWatchlist(db as unknown as Db, 5);

            expect(
                (db as unknown as { delete: ReturnType<typeof vi.fn> }).delete,
            ).toHaveBeenCalled();
            expect(db._chain.where).toHaveBeenCalled();
        });
    });

    describe('toggleWatchlistItem', () => {
        it('calls update().set().where() with correct params', async () => {
            await toggleWatchlistItem(db as unknown as Db, 2, false);

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith({ enabled: false });
            expect(db._chain.where).toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// Analysis config
// ---------------------------------------------------------------------------

describe('Analysis config queries', () => {
    describe('getAnalysisConfig', () => {
        it('returns first row when exists', async () => {
            const mockRow = { id: 1, analysisType: 'technical', modelId: 'gpt-4' };
            const db = createMockDb([mockRow]);

            const result = await getAnalysisConfig(db as unknown as Db, 'technical');

            expect(db._chain.from).toHaveBeenCalled();
            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.limit).toHaveBeenCalledWith(1);
            expect(result).toEqual(mockRow);
        });

        it('returns null when no rows', async () => {
            const db = createMockDb([]);

            const result = await getAnalysisConfig(db as unknown as Db, 'nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('getAllAnalysisConfigs', () => {
        it('returns all rows', async () => {
            const mockRows = [
                { id: 1, analysisType: 'technical' },
                { id: 2, analysisType: 'fundamental' },
            ];
            const db = createMockDb(mockRows);

            const result = await getAllAnalysisConfigs(db as unknown as Db);

            expect(db._chain.from).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('updateAnalysisConfig', () => {
        it('calls update().set().where() with merged updates and updatedAt', async () => {
            const db = createMockDb([]);

            await updateAnalysisConfig(db as unknown as Db, 'technical', {
                modelId: 'claude-4',
                enabled: true,
            });

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    modelId: 'claude-4',
                    enabled: true,
                    updatedAt: expect.any(Date),
                }),
            );
            expect(db._chain.where).toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// Config (key-value)
// ---------------------------------------------------------------------------

describe('Config queries', () => {
    describe('getConfigValue', () => {
        it('returns value when key exists', async () => {
            const db = createMockDb([{ key: 'theme', value: 'dark' }]);

            const result = await getConfigValue<string>(db as unknown as Db, 'theme');

            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.limit).toHaveBeenCalledWith(1);
            expect(result).toBe('dark');
        });

        it('returns null when key does not exist', async () => {
            const db = createMockDb([]);

            const result = await getConfigValue<string>(db as unknown as Db, 'missing');

            expect(result).toBeNull();
        });

        it('returns complex object values', async () => {
            const complexValue = { nested: { data: [1, 2, 3] } };
            const db = createMockDb([{ key: 'settings', value: complexValue }]);

            const result = await getConfigValue<typeof complexValue>(
                db as unknown as Db,
                'settings',
            );

            expect(result).toEqual(complexValue);
        });
    });

    describe('setConfigValue', () => {
        it('calls insert().values().onConflictDoUpdate()', async () => {
            const db = createMockDb(undefined);

            await setConfigValue(db as unknown as Db, 'theme', 'dark');

            expect(
                (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
            ).toHaveBeenCalled();
            expect(db._chain.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'theme',
                    value: 'dark',
                    updatedAt: expect.any(Date),
                }),
            );
            expect(db._chain.onConflictDoUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    set: expect.objectContaining({
                        value: 'dark',
                        updatedAt: expect.any(Date),
                    }),
                }),
            );
        });
    });

    describe('getAllConfig', () => {
        it('returns all config rows', async () => {
            const mockRows = [
                { key: 'a', value: 1 },
                { key: 'b', value: 2 },
            ];
            const db = createMockDb(mockRows);

            const result = await getAllConfig(db as unknown as Db);

            expect(db._chain.from).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });
});

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

describe('Analysis results queries', () => {
    describe('saveAnalysisResult', () => {
        it('calls insert().values().returning() with correct params', async () => {
            const params = {
                symbol: 'AAPL',
                analysisType: 'technical',
                result: { score: 85 },
                modelId: 'claude-4',
                analyzedAt: new Date('2026-01-15'),
                cronRunId: 'run-123',
            };
            const mockReturned = [{ id: 1, ...params }];
            const db = createMockDb(mockReturned);

            const result = await saveAnalysisResult(db as unknown as Db, params);

            expect(
                (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
            ).toHaveBeenCalled();
            expect(db._chain.values).toHaveBeenCalledWith(params);
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });
    });

    describe('getLatestAnalysisResult', () => {
        it('returns first row when exists', async () => {
            const mockRow = { id: 1, symbol: 'AAPL', analysisType: 'technical' };
            const db = createMockDb([mockRow]);

            const result = await getLatestAnalysisResult(db as unknown as Db, 'AAPL', 'technical');

            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.orderBy).toHaveBeenCalled();
            expect(db._chain.limit).toHaveBeenCalledWith(1);
            expect(result).toEqual(mockRow);
        });

        it('returns null when no results', async () => {
            const db = createMockDb([]);

            const result = await getLatestAnalysisResult(db as unknown as Db, 'AAPL', 'technical');

            expect(result).toBeNull();
        });
    });

    describe('getLatestAnalysisResults', () => {
        it('returns all results for symbol ordered desc', async () => {
            const mockRows = [
                { id: 2, symbol: 'AAPL', analysisType: 'fundamental' },
                { id: 1, symbol: 'AAPL', analysisType: 'technical' },
            ];
            const db = createMockDb(mockRows);

            const result = await getLatestAnalysisResults(db as unknown as Db, 'AAPL');

            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.orderBy).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

describe('Positions queries', () => {
    describe('getOpenPositions', () => {
        it('filters by status=open', async () => {
            const mockRows = [{ id: 1, symbol: 'AAPL', status: 'open' }];
            const db = createMockDb(mockRows);

            const result = await getOpenPositions(db as unknown as Db);

            expect(db._chain.where).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('getOpenPositionBySymbol', () => {
        it('returns position when exists', async () => {
            const mockRow = { id: 1, symbol: 'AAPL', status: 'open' };
            const db = createMockDb([mockRow]);

            const result = await getOpenPositionBySymbol(db as unknown as Db, 'AAPL');

            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.limit).toHaveBeenCalledWith(1);
            expect(result).toEqual(mockRow);
        });

        it('returns null when no open position for symbol', async () => {
            const db = createMockDb([]);

            const result = await getOpenPositionBySymbol(db as unknown as Db, 'AAPL');

            expect(result).toBeNull();
        });
    });

    describe('openPosition', () => {
        it('inserts with avgPrice as string and status=open', async () => {
            const mockReturned = [{ id: 1, symbol: 'AAPL', status: 'open' }];
            const db = createMockDb(mockReturned);

            const result = await openPosition(db as unknown as Db, {
                symbol: 'AAPL',
                side: 'buy',
                quantity: 10,
                avgPrice: 150.5,
            });

            expect(
                (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
            ).toHaveBeenCalled();
            expect(db._chain.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'AAPL',
                    side: 'buy',
                    quantity: 10,
                    avgPrice: '150.5',
                    status: 'open',
                    openedAt: expect.any(Date),
                }),
            );
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });
    });

    describe('closePosition', () => {
        it('updates with status=closed, closePrice as string, and closedAt', async () => {
            const db = createMockDb([]);

            await closePosition(db as unknown as Db, 1, 175.25);

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'closed',
                    closePrice: '175.25',
                    closedAt: expect.any(Date),
                }),
            );
            expect(db._chain.where).toHaveBeenCalled();
        });
    });

    describe('reducePositionQuantity', () => {
        it('executes atomic SQL update to reduce quantity', async () => {
            const db = createMockDb([{ id: 1 }]);

            const result = await reducePositionQuantity(db as unknown as Db, 1, 3);

            expect(db.execute).toHaveBeenCalledTimes(1);
            expect(result).toBe(true);
        });

        it('returns false when no rows matched', async () => {
            const db = createMockDb([]);

            const result = await reducePositionQuantity(db as unknown as Db, 999, 5);

            expect(db.execute).toHaveBeenCalledTimes(1);
            expect(result).toBe(false);
        });

        it('returns true when rowCount is returned instead of array', async () => {
            const db = createMockDb({ rowCount: 1 } as any);

            const result = await reducePositionQuantity(db as unknown as Db, 1, 2);

            expect(result).toBe(true);
        });
    });

    describe('averageIntoPosition', () => {
        it('executes atomic SQL update with correct parameters', async () => {
            const db = createMockDb();

            await averageIntoPosition(db as unknown as Db, 1, 5, 150);

            // Should use db.execute for atomic SQL update
            expect(db.execute).toHaveBeenCalledTimes(1);
            // No select/update chain should be used
            expect(db.select).not.toHaveBeenCalled();
        });

        it('executes atomic update even when position may not exist (WHERE clause handles it)', async () => {
            const db = createMockDb();

            await averageIntoPosition(db as unknown as Db, 999, 5, 150);

            // Should still call execute — the WHERE clause filters non-existent/closed positions
            expect(db.execute).toHaveBeenCalledTimes(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

describe('Trades queries', () => {
    describe('insertTrade', () => {
        it('inserts trade with price converted to string', async () => {
            const executedAt = new Date('2026-01-15T10:00:00Z');
            const mockReturned = [{ id: 1 }];
            const db = createMockDb(mockReturned);

            const result = await insertTrade(db as unknown as Db, {
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 5,
                price: 150.75,
                executedAt,
                reason: 'Signal triggered',
                mode: 'auto',
                cronRunId: 'run-456',
            });

            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 5,
                price: '150.75',
                executedAt,
                reason: 'Signal triggered',
                mode: 'auto',
                cronRunId: 'run-456',
                clientOrderId: undefined,
                realizedPnl: undefined,
            });
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });

        it('handles undefined optional fields', async () => {
            const executedAt = new Date('2026-01-15T10:00:00Z');
            const db = createMockDb([{ id: 1 }]);

            await insertTrade(db as unknown as Db, {
                symbol: 'MSFT',
                side: 'sell',
                orderType: 'limit',
                quantity: 3,
                price: 400.0,
                executedAt,
                mode: 'manual',
            });

            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'MSFT',
                side: 'sell',
                orderType: 'limit',
                quantity: 3,
                price: '400',
                executedAt,
                reason: undefined,
                mode: 'manual',
                cronRunId: undefined,
                clientOrderId: undefined,
                realizedPnl: undefined,
            });
        });

        it('inserts clientOrderId and realizedPnl when provided, realizedPnl as string', async () => {
            const executedAt = new Date('2026-01-15T10:00:00Z');
            const mockReturned = [{ id: 2 }];
            const db = createMockDb(mockReturned);

            const result = await insertTrade(db as unknown as Db, {
                symbol: 'NVDA',
                side: 'sell',
                orderType: 'market',
                quantity: 10,
                price: 900.0,
                executedAt,
                mode: 'auto',
                cronRunId: 'run-789',
                clientOrderId: 'uuid-client-order-123',
                realizedPnl: 250.75,
            });

            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'NVDA',
                side: 'sell',
                orderType: 'market',
                quantity: 10,
                price: '900',
                executedAt,
                reason: undefined,
                mode: 'auto',
                cronRunId: 'run-789',
                clientOrderId: 'uuid-client-order-123',
                realizedPnl: '250.75',
            });
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });

        it('stores realizedPnl as undefined when null/undefined (not string)', async () => {
            const executedAt = new Date('2026-01-15T10:00:00Z');
            const db = createMockDb([{ id: 3 }]);

            await insertTrade(db as unknown as Db, {
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 5,
                price: 150.0,
                executedAt,
                mode: 'auto',
                clientOrderId: 'uuid-client-order-456',
            });

            expect(db._chain.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    clientOrderId: 'uuid-client-order-456',
                    realizedPnl: undefined,
                }),
            );
        });
    });

    describe('getRecentTrades', () => {
        it('orders desc and uses default limit of 50', async () => {
            const mockRows = [{ id: 1 }, { id: 2 }];
            const db = createMockDb(mockRows);

            const result = await getRecentTrades(db as unknown as Db);

            expect(db._chain.orderBy).toHaveBeenCalled();
            expect(db._chain.limit).toHaveBeenCalledWith(50);
            expect(result).toEqual(mockRows);
        });

        it('uses custom limit when provided', async () => {
            const db = createMockDb([]);

            await getRecentTrades(db as unknown as Db, 10);

            expect(db._chain.limit).toHaveBeenCalledWith(10);
        });
    });

    describe('getTodayTradeCount', () => {
        it('returns count of today trades', async () => {
            const mockRows = [{ count: 3 }];
            const db = createMockDb(mockRows);

            const result = await getTodayTradeCount(db as unknown as Db);

            expect(db._chain.where).toHaveBeenCalled();
            expect(result).toBe(3);
        });

        it('returns 0 when no trades today', async () => {
            const db = createMockDb([{ count: 0 }]);

            const result = await getTodayTradeCount(db as unknown as Db);

            expect(result).toBe(0);
        });
    });

    describe('getTodayRealizedPnl', () => {
        // getTodayRealizedPnl now uses the typed drizzle select builder
        // (db.select().from().where()) to avoid db.execute() driver-shape
        // ambiguity (raw array vs {rows:[...]}) that silently returned 0.
        // Tests mirror the pattern used by getTodayTradeCount above.

        it('sums today realized_pnl over non-dry/non-skipped sell trades', async () => {
            const db = createMockDb([{ pnl: 450 }]);

            const result = await getTodayRealizedPnl(db as unknown as Db);

            expect(result).toBe(450);
            // Uses typed select builder — NOT db.execute
            expect(db.execute).not.toHaveBeenCalled();
            expect(db._chain.from).toHaveBeenCalled();
            expect(db._chain.where).toHaveBeenCalled();
        });

        it('returns 0 when sum is zero', async () => {
            const db = createMockDb([{ pnl: 0 }]);

            const result = await getTodayRealizedPnl(db as unknown as Db);

            expect(result).toBe(0);
        });

        it('returns 0 when pnl value is null (COALESCE default)', async () => {
            const db = createMockDb([{ pnl: null }]);

            const result = await getTodayRealizedPnl(db as unknown as Db);

            expect(result).toBe(0);
        });

        it('returns 0 when result row is missing (empty array)', async () => {
            const db = createMockDb([]);

            const result = await getTodayRealizedPnl(db as unknown as Db);

            expect(result).toBe(0);
        });

        it('handles negative realized PnL from losing sells', async () => {
            const db = createMockDb([{ pnl: -500 }]);

            const result = await getTodayRealizedPnl(db as unknown as Db);

            expect(result).toBe(-500);
        });
    });
});

// ---------------------------------------------------------------------------
// Pending orders
// ---------------------------------------------------------------------------

describe('Pending orders queries', () => {
    describe('insertPendingOrder', () => {
        it('inserts with numeric fields converted to strings', async () => {
            const expiresAt = new Date('2026-01-16T00:00:00Z');
            const mockReturned = [{ id: 1 }];
            const db = createMockDb(mockReturned);

            const result = await insertPendingOrder(db as unknown as Db, {
                symbol: 'AAPL',
                side: 'buy',
                quantity: 10,
                priceLimit: 155.5,
                analysisSummary: 'Strong buy signal',
                signalScore: 0.85,
                expiresAt,
            });

            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'AAPL',
                side: 'buy',
                quantity: 10,
                priceLimit: '155.5',
                analysisSummary: 'Strong buy signal',
                signalScore: '0.85',
                expiresAt,
                status: 'pending',
            });
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });

        it('handles undefined optional numeric fields', async () => {
            const expiresAt = new Date('2026-01-16T00:00:00Z');
            const db = createMockDb([{ id: 1 }]);

            await insertPendingOrder(db as unknown as Db, {
                symbol: 'MSFT',
                side: 'sell',
                quantity: 5,
                expiresAt,
            });

            expect(db._chain.values).toHaveBeenCalledWith({
                symbol: 'MSFT',
                side: 'sell',
                quantity: 5,
                priceLimit: undefined,
                analysisSummary: undefined,
                signalScore: undefined,
                expiresAt,
                status: 'pending',
            });
        });
    });

    describe('getPendingOrders', () => {
        it('filters by status=pending and excludes expired, ordered by createdAt desc', async () => {
            const mockRows = [{ id: 1, status: 'pending' }];
            const db = createMockDb(mockRows);

            const result = await getPendingOrders(db as unknown as Db);

            expect(db._chain.where).toHaveBeenCalled();
            expect(db._chain.orderBy).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('expireOldPendingOrders', () => {
        it('updates expired pending orders to status=expired', async () => {
            const db = createMockDb([]);

            await expireOldPendingOrders(db as unknown as Db);

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith({ status: 'expired' });
            expect(db._chain.where).toHaveBeenCalled();
        });
    });

    describe('approvePendingOrder', () => {
        it('updates status to approved', async () => {
            const db = createMockDb([]);

            await approvePendingOrder(db as unknown as Db, 7);

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith({ status: 'approved' });
            expect(db._chain.where).toHaveBeenCalled();
        });
    });

    describe('rejectPendingOrder', () => {
        it('updates status to rejected', async () => {
            const db = createMockDb([]);

            await rejectPendingOrder(db as unknown as Db, 9);

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith({ status: 'rejected' });
            expect(db._chain.where).toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('Notification config queries', () => {
    describe('getNotificationConfig', () => {
        it('returns all notification config rows', async () => {
            const mockRows = [
                { id: 1, channel: 'email', enabled: true },
                { id: 2, channel: 'slack', enabled: false },
            ];
            const db = createMockDb(mockRows);

            const result = await getNotificationConfig(db as unknown as Db);

            expect(db._chain.from).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });

    describe('updateNotificationConfig', () => {
        it('updates by channel with correct fields', async () => {
            const db = createMockDb([]);

            await updateNotificationConfig(db as unknown as Db, 'email', {
                enabled: false,
                target: 'user@example.com',
                events: ['trade', 'signal'],
            });

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith({
                enabled: false,
                target: 'user@example.com',
                events: ['trade', 'signal'],
            });
            expect(db._chain.where).toHaveBeenCalled();
        });

        it('updates with partial fields', async () => {
            const db = createMockDb([]);

            await updateNotificationConfig(db as unknown as Db, 'slack', {
                enabled: true,
            });

            expect(db._chain.set).toHaveBeenCalledWith({ enabled: true });
        });
    });
});

// ---------------------------------------------------------------------------
// Order tracking
// ---------------------------------------------------------------------------

describe('Order tracking queries', () => {
    describe('createOrderTracking', () => {
        it('inserts order tracking record with correct params', async () => {
            const mockReturned = [{ id: 1, idempotencyKey: 'exec-abc-AAPL-buy' }];
            const db = createMockDb(mockReturned);

            const result = await createOrderTracking(db as unknown as Db, {
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 5,
                status: 'submitted',
                cronRunId: 'exec-abc',
            });

            expect(
                (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
            ).toHaveBeenCalled();
            expect(db._chain.values).toHaveBeenCalledWith({
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 5,
                tossOrderId: undefined,
                status: 'submitted',
                cronRunId: 'exec-abc',
            });
            expect(db._chain.returning).toHaveBeenCalled();
            expect(result).toEqual(mockReturned);
        });

        it('includes tossOrderId when provided', async () => {
            const db = createMockDb([{ id: 1 }]);

            await createOrderTracking(db as unknown as Db, {
                idempotencyKey: 'exec-abc-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                quantity: 10,
                tossOrderId: 'ORD-123',
                status: 'filled',
                cronRunId: 'exec-abc',
            });

            expect(db._chain.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    tossOrderId: 'ORD-123',
                }),
            );
        });

        it('includes clientOrderId when provided', async () => {
            const db = createMockDb([{ id: 1 }]);

            await createOrderTracking(db as unknown as Db, {
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                quantity: 3,
                clientOrderId: 'uuid-client-order-id',
                status: 'submitted',
                cronRunId: 'exec-abc',
            });

            expect(db._chain.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    clientOrderId: 'uuid-client-order-id',
                }),
            );
        });
    });

    describe('updateOrderTracking', () => {
        it('updates order tracking with status and tossOrderId', async () => {
            const db = createMockDb([]);

            await updateOrderTracking(db as unknown as Db, 'exec-abc-AAPL-buy', {
                status: 'filled',
                tossOrderId: 'ORD-456',
            });

            expect(
                (db as unknown as { update: ReturnType<typeof vi.fn> }).update,
            ).toHaveBeenCalled();
            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'filled',
                    tossOrderId: 'ORD-456',
                }),
            );
            expect(db._chain.where).toHaveBeenCalled();
        });

        it('converts filledPrice to string', async () => {
            const db = createMockDb([]);

            await updateOrderTracking(db as unknown as Db, 'exec-abc-AAPL-buy', {
                filledPrice: 150.5,
            });

            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    filledPrice: '150.5',
                }),
            );
        });

        it('does not convert filledPrice when undefined', async () => {
            const db = createMockDb([]);

            await updateOrderTracking(db as unknown as Db, 'exec-abc-AAPL-buy', {
                status: 'rejected',
            });

            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    filledPrice: undefined,
                }),
            );
        });

        it('passes resolvedAt when provided', async () => {
            const db = createMockDb([]);
            const resolvedAt = new Date('2026-05-25T10:00:00Z');

            await updateOrderTracking(db as unknown as Db, 'exec-abc-AAPL-buy', {
                status: 'filled',
                resolvedAt,
            });

            expect(db._chain.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    resolvedAt,
                }),
            );
        });
    });

    describe('getPendingSubmittedOrders', () => {
        it('returns all in-flight orders (submitted/pending/partial) ordered by submittedAt', async () => {
            const mockRows = [
                { id: 1, status: 'submitted', symbol: 'AAPL' },
                { id: 2, status: 'pending', symbol: 'TSLA' },
                { id: 3, status: 'partial', symbol: 'MSFT' },
            ];
            const db = createMockDb(mockRows);

            const result = await getPendingSubmittedOrders(db as unknown as Db);

            expect(db._chain.from).toHaveBeenCalled();
            expect(db._chain.where).toHaveBeenCalled();
            // where() must be called with an inArray() over all unfilled-in-flight statuses
            const expectedWhere = inArray(orderTracking.status, [
                'submitted',
                'pending',
                'partial',
            ]);
            expect(db._chain.where).toHaveBeenCalledWith(expectedWhere);
            expect(db._chain.orderBy).toHaveBeenCalled();
            expect(result).toEqual(mockRows);
        });
    });
});
