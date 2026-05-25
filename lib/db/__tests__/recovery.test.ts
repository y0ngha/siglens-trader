import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkConsistency } from '../recovery';

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
