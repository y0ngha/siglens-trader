import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkConsistency, autoRecoverFilledOrders } from '../recovery';
import {
    insertTrade,
    openPosition,
    closePosition,
    reducePositionQuantity,
    averageIntoPosition,
    getOpenPositionBySymbol,
    updateOrderTracking,
} from '../queries';

vi.mock('../queries', () => ({
    insertTrade: vi.fn().mockResolvedValue([{ id: 1 }]),
    openPosition: vi.fn().mockResolvedValue([{ id: 1 }]),
    closePosition: vi.fn().mockResolvedValue(true),
    reducePositionQuantity: vi.fn().mockResolvedValue(true),
    averageIntoPosition: vi.fn().mockResolvedValue(undefined),
    getOpenPositionBySymbol: vi.fn().mockResolvedValue(null),
    updateOrderTracking: vi.fn().mockResolvedValue(undefined),
}));

const mockInsertTrade = vi.mocked(insertTrade);
const mockOpenPosition = vi.mocked(openPosition);
const mockClosePosition = vi.mocked(closePosition);
const mockReducePositionQuantity = vi.mocked(reducePositionQuantity);
const mockAverageIntoPosition = vi.mocked(averageIntoPosition);
const mockGetOpenPositionBySymbol = vi.mocked(getOpenPositionBySymbol);
const mockUpdateOrderTracking = vi.mocked(updateOrderTracking);

describe('checkConsistency', () => {
    let mockDb: {
        select: ReturnType<typeof vi.fn>;
        from: ReturnType<typeof vi.fn>;
        where: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        mockDb = {
            select: vi.fn(),
            from: vi.fn(),
            where: vi.fn(),
        };
        // Chain: db.select().from(table).where(condition)
        mockDb.select.mockReturnValue(mockDb);
        mockDb.from.mockReturnValue(mockDb);
        mockDb.where.mockResolvedValue([]);
    });

    it('returns empty report when no filled orders exist', async () => {
        const report = await checkConsistency(mockDb as any);

        expect(report).toEqual({
            filledOrdersWithoutTrades: 0,
            filledOrdersWithoutPositions: 0,
            openPositionsWithoutTrades: 0,
            alerts: [],
        });
    });

    it('detects filled orders without matching trades', async () => {
        const filledOrders = [
            {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                submittedAt: new Date('2026-05-24T10:00:00Z'),
            },
            {
                id: 2,
                idempotencyKey: 'exec-def-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                submittedAt: new Date('2026-05-24T11:00:00Z'),
            },
        ];

        // First call returns filled orders, subsequent calls return no matching trades
        mockDb.where
            .mockResolvedValueOnce(filledOrders) // filled orders query
            .mockResolvedValueOnce([]) // AAPL: no matching trade
            .mockResolvedValueOnce([]); // TSLA: no matching trade

        const report = await checkConsistency(mockDb as any);

        expect(report.filledOrdersWithoutTrades).toBe(2);
        expect(report.alerts).toHaveLength(2);
        expect(report.alerts[0]).toContain('exec-abc-AAPL-buy');
        expect(report.alerts[0]).toContain('AAPL');
        expect(report.alerts[1]).toContain('exec-def-TSLA-sell');
        expect(report.alerts[1]).toContain('TSLA');
    });

    it('does not generate alert when filled order has matching trade', async () => {
        const filledOrders = [
            {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                submittedAt: new Date('2026-05-24T10:00:00Z'),
            },
        ];

        mockDb.where
            .mockResolvedValueOnce(filledOrders) // filled orders query
            .mockResolvedValueOnce([{ id: 10, symbol: 'AAPL', side: 'buy' }]); // matching trade

        const report = await checkConsistency(mockDb as any);

        expect(report.filledOrdersWithoutTrades).toBe(0);
        expect(report.alerts).toHaveLength(0);
    });

    it('handles mixed results — some with trades, some without', async () => {
        const filledOrders = [
            {
                id: 1,
                idempotencyKey: 'exec-abc-AAPL-buy',
                symbol: 'AAPL',
                side: 'buy',
                submittedAt: new Date('2026-05-24T10:00:00Z'),
            },
            {
                id: 2,
                idempotencyKey: 'exec-def-TSLA-sell',
                symbol: 'TSLA',
                side: 'sell',
                submittedAt: new Date('2026-05-24T11:00:00Z'),
            },
        ];

        mockDb.where
            .mockResolvedValueOnce(filledOrders) // filled orders query
            .mockResolvedValueOnce([{ id: 10, symbol: 'AAPL', side: 'buy' }]) // AAPL: has trade
            .mockResolvedValueOnce([]); // TSLA: no trade

        const report = await checkConsistency(mockDb as any);

        expect(report.filledOrdersWithoutTrades).toBe(1);
        expect(report.alerts).toHaveLength(1);
        expect(report.alerts[0]).toContain('TSLA');
    });
});

// ---------------------------------------------------------------------------
// autoRecoverFilledOrders
// ---------------------------------------------------------------------------

describe('autoRecoverFilledOrders', () => {
    function createChainableMockDb() {
        const limitFn = vi.fn().mockResolvedValue([]);
        const chain = {
            select: vi.fn(),
            from: vi.fn(),
            where: vi.fn(),
            limit: limitFn,
            transaction: vi.fn(),
        };
        chain.select.mockReturnValue(chain);
        chain.from.mockReturnValue(chain);
        chain.where.mockReturnValue(chain);
        return chain;
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 0 recovered when no filled orders exist', async () => {
        const mockDb = createChainableMockDb();
        // First .where() call (filled orders query) returns empty
        mockDb.where.mockResolvedValueOnce([]);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result).toEqual({ recovered: 0, failed: 0, details: [] });
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('skips filled order that already has matching trade', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 1,
            idempotencyKey: 'exec-abc-AAPL-buy',
            symbol: 'AAPL',
            side: 'buy',
            quantity: 5,
            filledPrice: '150.00',
            submittedAt: new Date('2026-05-24T10:00:00Z'),
            resolvedAt: new Date('2026-05-24T10:01:00Z'),
            cronRunId: 'run-1',
        };

        // First .where() → filled orders, then matching trade exists
        mockDb.where.mockResolvedValueOnce([filledOrder]);
        // .limit(1) for matching trades query → returns a match
        mockDb.limit.mockResolvedValueOnce([{ id: 10, symbol: 'AAPL', side: 'buy' }]);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result).toEqual({ recovered: 0, failed: 0, details: [] });
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('recovers filled buy order without trade — creates trade + opens position', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 1,
            idempotencyKey: 'exec-abc-AAPL-buy',
            symbol: 'AAPL',
            side: 'buy',
            quantity: 5,
            filledPrice: '150.00',
            submittedAt: new Date('2026-05-24T10:00:00Z'),
            resolvedAt: new Date('2026-05-24T10:01:00Z'),
            cronRunId: 'run-1',
        };

        // First .where() → filled orders
        mockDb.where.mockResolvedValueOnce([filledOrder]);
        // .limit(1) → no matching trade
        mockDb.limit.mockResolvedValueOnce([]);

        // Mock transaction to execute the callback
        mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
            await fn(mockDb);
        });

        // getOpenPositionBySymbol → null (no existing position)
        mockGetOpenPositionBySymbol.mockResolvedValueOnce(null as any);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.details[0]).toContain('AAPL');
        expect(result.details[0]).toContain('자동 복구 완료');

        expect(mockInsertTrade).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 5,
                price: 150,
                mode: 'auto',
                cronRunId: 'run-1',
            }),
        );
        expect(mockOpenPosition).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                symbol: 'AAPL',
                side: 'long',
                quantity: 5,
                avgPrice: 150,
            }),
        );
        expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
            expect.anything(),
            'exec-abc-AAPL-buy',
            expect.objectContaining({ status: 'recovered' }),
        );
    });

    it('recovers filled buy order — averages into existing position', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 1,
            idempotencyKey: 'exec-abc-AAPL-buy',
            symbol: 'AAPL',
            side: 'buy',
            quantity: 3,
            filledPrice: '160.00',
            submittedAt: new Date('2026-05-24T10:00:00Z'),
            resolvedAt: new Date('2026-05-24T10:01:00Z'),
            cronRunId: 'run-1',
        };

        mockDb.where.mockResolvedValueOnce([filledOrder]);
        mockDb.limit.mockResolvedValueOnce([]);
        mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
            await fn(mockDb);
        });

        // Existing open position
        mockGetOpenPositionBySymbol.mockResolvedValueOnce({
            id: 42,
            symbol: 'AAPL',
            quantity: 10,
            avgPrice: '150.00',
            status: 'open',
        } as any);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(1);
        expect(mockAverageIntoPosition).toHaveBeenCalledWith(expect.anything(), 42, 3, 160);
        expect(mockOpenPosition).not.toHaveBeenCalled();
    });

    it('recovers filled sell order — closes position when quantity matches', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 2,
            idempotencyKey: 'exec-def-TSLA-sell',
            symbol: 'TSLA',
            side: 'sell',
            quantity: 10,
            filledPrice: '250.00',
            submittedAt: new Date('2026-05-24T11:00:00Z'),
            resolvedAt: new Date('2026-05-24T11:01:00Z'),
            cronRunId: 'run-2',
        };

        mockDb.where.mockResolvedValueOnce([filledOrder]);
        mockDb.limit.mockResolvedValueOnce([]);
        mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
            await fn(mockDb);
        });

        mockGetOpenPositionBySymbol.mockResolvedValueOnce({
            id: 7,
            symbol: 'TSLA',
            quantity: 10,
            avgPrice: '200.00',
            status: 'open',
        } as any);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(1);
        expect(mockClosePosition).toHaveBeenCalledWith(expect.anything(), 7, 250);
        expect(mockReducePositionQuantity).not.toHaveBeenCalled();
    });

    it('recovers filled sell order — reduces position when partial sell', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 2,
            idempotencyKey: 'exec-def-TSLA-sell',
            symbol: 'TSLA',
            side: 'sell',
            quantity: 3,
            filledPrice: '250.00',
            submittedAt: new Date('2026-05-24T11:00:00Z'),
            resolvedAt: new Date('2026-05-24T11:01:00Z'),
            cronRunId: 'run-2',
        };

        mockDb.where.mockResolvedValueOnce([filledOrder]);
        mockDb.limit.mockResolvedValueOnce([]);
        mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
            await fn(mockDb);
        });

        mockGetOpenPositionBySymbol.mockResolvedValueOnce({
            id: 7,
            symbol: 'TSLA',
            quantity: 10,
            avgPrice: '200.00',
            status: 'open',
        } as any);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(1);
        expect(mockReducePositionQuantity).toHaveBeenCalledWith(expect.anything(), 7, 3);
        expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it('fails when filledPrice is missing or zero', async () => {
        const mockDb = createChainableMockDb();
        const orderNoPrice = {
            id: 3,
            idempotencyKey: 'exec-ghi-MSFT-buy',
            symbol: 'MSFT',
            side: 'buy',
            quantity: 5,
            filledPrice: null,
            submittedAt: new Date('2026-05-24T12:00:00Z'),
            resolvedAt: new Date('2026-05-24T12:01:00Z'),
            cronRunId: 'run-3',
        };

        mockDb.where.mockResolvedValueOnce([orderNoPrice]);
        mockDb.limit.mockResolvedValueOnce([]);

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.details[0]).toContain('체결가 없어 자동 복구 불가');
        expect(result.details[0]).toContain('MSFT');
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('increments failed count when DB transaction throws', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 1,
            idempotencyKey: 'exec-abc-AAPL-buy',
            symbol: 'AAPL',
            side: 'buy',
            quantity: 5,
            filledPrice: '150.00',
            submittedAt: new Date('2026-05-24T10:00:00Z'),
            resolvedAt: new Date('2026-05-24T10:01:00Z'),
            cronRunId: 'run-1',
        };

        mockDb.where.mockResolvedValueOnce([filledOrder]);
        mockDb.limit.mockResolvedValueOnce([]);

        // getOpenPositionBySymbol called before transaction
        mockGetOpenPositionBySymbol.mockResolvedValueOnce(null as any);

        // Transaction fails
        mockDb.transaction.mockRejectedValueOnce(new Error('DB connection lost'));

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.details[0]).toContain('자동 복구 실패');
        expect(result.details[0]).toContain('DB connection lost');
        expect(mockUpdateOrderTracking).not.toHaveBeenCalled();
    });

    it('recovers sell order but warns when no open position exists', async () => {
        const mockDb = createChainableMockDb();
        const filledOrder = {
            id: 1,
            idempotencyKey: 'exec-abc-AAPL-sell',
            symbol: 'AAPL',
            side: 'sell',
            quantity: 5,
            filledPrice: '195.00',
            submittedAt: new Date('2026-05-24T10:00:00Z'),
            resolvedAt: new Date('2026-05-24T10:01:00Z'),
            cronRunId: 'run-1',
        };

        mockDb.where.mockResolvedValueOnce([filledOrder]);
        mockDb.limit.mockResolvedValueOnce([]);

        // No open position exists
        mockGetOpenPositionBySymbol.mockResolvedValueOnce(null as any);

        // Transaction succeeds (trade inserted, no position change)
        mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(mockDb));

        const result = await autoRecoverFilledOrders(mockDb as any);

        expect(result.recovered).toBe(1);
        expect(result.failed).toBe(0);
        // Should have trade creation
        expect(mockInsertTrade).toHaveBeenCalled();
        // Should NOT have position close/reduce (no position)
        expect(mockClosePosition).not.toHaveBeenCalled();
        expect(mockReducePositionQuantity).not.toHaveBeenCalled();
        // Should have warning in details
        const warning = result.details.find((d) => d.includes('열린 포지션 없음'));
        expect(warning).toBeDefined();
        expect(warning).toContain('AAPL');
        expect(warning).toContain('브로커 확인 필요');
        // Should still be marked recovered
        expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
            mockDb,
            'exec-abc-AAPL-sell',
            expect.objectContaining({ status: 'recovered' }),
        );
    });
});
