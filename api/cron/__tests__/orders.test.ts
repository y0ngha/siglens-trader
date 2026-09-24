import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = {
    averageIntoPosition: vi.fn(),
    closePosition: vi.fn(),
    createOrderTracking: vi.fn(),
    getOpenPositionBySymbol: vi.fn(),
    insertPendingOrder: vi.fn(),
    insertTrade: vi.fn(),
    openPosition: vi.fn(),
    reducePositionQuantity: vi.fn(),
    updateOrderTracking: vi.fn(),
};
vi.mock('../../../lib/db/queries', () => ({
    averageIntoPosition: (...a: unknown[]) => q.averageIntoPosition(...a),
    closePosition: (...a: unknown[]) => q.closePosition(...a),
    createOrderTracking: (...a: unknown[]) => q.createOrderTracking(...a),
    getOpenPositionBySymbol: (...a: unknown[]) => q.getOpenPositionBySymbol(...a),
    insertPendingOrder: (...a: unknown[]) => q.insertPendingOrder(...a),
    insertTrade: (...a: unknown[]) => q.insertTrade(...a),
    openPosition: (...a: unknown[]) => q.openPosition(...a),
    reducePositionQuantity: (...a: unknown[]) => q.reducePositionQuantity(...a),
    updateOrderTracking: (...a: unknown[]) => q.updateOrderTracking(...a),
}));

const mockBuy = vi.fn();
const mockSell = vi.fn();
vi.mock('../../../lib/trading/orders', () => ({
    executeBuyOrder: (...a: unknown[]) => mockBuy(...a),
    executeSellOrder: (...a: unknown[]) => mockSell(...a),
}));
const mockSellable = vi.fn();
vi.mock('../../../lib/trading/account', () => ({
    getSellableQuantity: (...a: unknown[]) => mockSellable(...a),
}));

import { executeEntry, executeExit, dryRunFillPrice, type OrderContext } from '../_orders';
import type { Db } from '../../../lib/db/index';

const tx = { tx: true };
const db = { transaction: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx) } as unknown as Db;
const dispatcher = {
    notifyTradeExecuted: vi.fn().mockResolvedValue(undefined),
    notifyApprovalRequest: vi.fn().mockResolvedValue(undefined),
    notifyError: vi.fn().mockResolvedValue(undefined),
};
const notifyError = vi.fn().mockResolvedValue(undefined);
const ctx = (tradingMode: OrderContext['tradingMode'], dryRunCostBps = 10): OrderContext => ({
    db,
    tradingMode,
    cronRunId: 'exec-1',
    dispatcher,
    notifyError,
    dryRunCostBps,
});
const position = { id: 7, symbol: 'NVDA', quantity: 10, avgPrice: '100' };
const exitArgs = { position, quantity: 10, price: 110, reason: 'MA5 회복', isStopLoss: false };
const entryArgs = {
    symbol: 'NVDA',
    quantity: 10,
    price: 100,
    reason: 'RSI(2) 4.2',
    stopPrice: 90,
    score: 4.2,
    remainingBuyingPower: 5000 as number | null,
};

beforeEach(() => {
    vi.clearAllMocks();
    q.closePosition.mockResolvedValue(true);
    q.reducePositionQuantity.mockResolvedValue(true);
    q.averageIntoPosition.mockResolvedValue(true);
    q.getOpenPositionBySymbol.mockResolvedValue(null);
    q.updateOrderTracking.mockResolvedValue(undefined);
    mockSellable.mockResolvedValue(null);
});

describe('dryRunFillPrice', () => {
    it('charges the cost on both sides', () => {
        expect(dryRunFillPrice(100, 'buy', 10)).toBeCloseTo(100.1);
        expect(dryRunFillPrice(100, 'sell', 10)).toBeCloseTo(99.9);
        expect(dryRunFillPrice(100, 'buy', 0)).toBe(100);
    });
});

describe('executeExit — dry_run', () => {
    it('closes a full position at the cost-adjusted price and books realized PnL', async () => {
        const out = await executeExit(ctx('dry_run'), exitArgs);
        const fill = 110 * 0.999;
        expect(q.closePosition).toHaveBeenCalledWith(tx, 7, fill);
        expect(q.insertTrade).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                side: 'sell',
                price: fill,
                quantity: 10,
                mode: 'dry_run',
                realizedPnl: (fill - 100) * 10,
            }),
        );
        expect(dispatcher.notifyTradeExecuted).toHaveBeenCalledWith(
            expect.objectContaining({ price: fill }),
            'trade_executed',
        );
        expect(out).toEqual({ executed: true, exposureDelta: -1000, cashDebit: 0 });
    });

    it('reduces a partial exit and routes a stop-loss to the stop_loss event', async () => {
        await executeExit(ctx('dry_run'), { ...exitArgs, quantity: 4, isStopLoss: true });
        expect(q.reducePositionQuantity).toHaveBeenCalledWith(tx, 7, 4);
        expect(q.closePosition).not.toHaveBeenCalled();
        expect(dispatcher.notifyTradeExecuted).toHaveBeenCalledWith(expect.anything(), 'stop_loss');
    });

    it('reports already_closed when the position moved underneath (no trade kept)', async () => {
        q.closePosition.mockResolvedValue(false);
        const out = await executeExit(ctx('dry_run'), exitArgs);
        expect(out.action).toBe('already_closed');
        expect(out.executed).toBe(false);
        q.reducePositionQuantity.mockResolvedValue(false);
        expect((await executeExit(ctx('dry_run'), { ...exitArgs, quantity: 3 })).action).toBe(
            'already_closed',
        );
    });

    it('rethrows anything else', async () => {
        q.insertTrade.mockRejectedValueOnce(new Error('db'));
        await expect(executeExit(ctx('dry_run'), exitArgs)).rejects.toThrow('db');
    });
});

describe('executeExit — semi_auto', () => {
    it('queues an approval and is not a fill', async () => {
        const out = await executeExit(ctx('semi_auto'), exitArgs);
        expect(q.insertPendingOrder).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ side: 'sell', quantity: 10, priceLimit: 110 }),
        );
        expect(dispatcher.notifyApprovalRequest).toHaveBeenCalled();
        expect(out).toEqual({ executed: false, exposureDelta: 0, cashDebit: 0 });
    });
});

describe('executeExit — auto', () => {
    it('books a clean fill atomically and tracks it as filled', async () => {
        mockSell.mockResolvedValue({
            status: 'filled',
            avgFilledPrice: 111,
            filledQuantity: 10,
            orderId: 'o1',
        });
        const out = await executeExit(ctx('auto'), exitArgs);
        expect(q.createOrderTracking).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                idempotencyKey: 'exec-1-NVDA-sell',
                side: 'sell',
                quantity: 10,
            }),
        );
        expect(q.insertTrade).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ price: 111, mode: 'auto', realizedPnl: 110 }),
        );
        expect(q.updateOrderTracking).toHaveBeenCalledWith(
            tx,
            'exec-1-NVDA-sell',
            expect.objectContaining({ status: 'filled' }),
        );
        expect(out).toEqual({ executed: true, exposureDelta: -1000, cashDebit: 0 });
    });

    it('clamps to the sellable quantity and skips when nothing is sellable', async () => {
        mockSellable.mockResolvedValue(4.7);
        mockSell.mockResolvedValue({ status: 'filled', avgFilledPrice: 111, filledQuantity: 4 });
        await executeExit(ctx('auto'), exitArgs);
        expect(mockSell).toHaveBeenCalledWith('NVDA', 4, expect.any(String));
        mockSellable.mockResolvedValue(0.5);
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('skipped_not_sellable');
    });

    it('rejected / pending / partial / short fill each leave no trade', async () => {
        mockSell.mockResolvedValueOnce({ status: 'rejected', rejectReason: 'no' });
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('order_rejected');
        mockSell.mockResolvedValueOnce({ status: 'pending', orderId: 'o' });
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('order_submitted');
        mockSell.mockResolvedValueOnce({ status: 'partial', filledQuantity: 3 });
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('order_partial');
        mockSell.mockResolvedValueOnce({ status: 'filled', avgFilledPrice: 0, filledQuantity: 10 });
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('needs_review');
        expect(q.insertTrade).not.toHaveBeenCalled();
    });

    it('marks tracking error and rethrows when the broker call throws', async () => {
        mockSell.mockRejectedValueOnce(new Error('timeout'));
        await expect(executeExit(ctx('auto'), exitArgs)).rejects.toThrow('timeout');
        expect(q.updateOrderTracking).toHaveBeenCalledWith(
            db,
            'exec-1-NVDA-sell',
            expect.objectContaining({ status: 'error' }),
        );
    });

    it('reports already_closed when booking finds the position gone', async () => {
        mockSell.mockResolvedValue({ status: 'filled', avgFilledPrice: 111, filledQuantity: 10 });
        q.closePosition.mockResolvedValue(false);
        expect((await executeExit(ctx('auto'), exitArgs)).action).toBe('already_closed');
    });
});

describe('executeEntry — dry_run', () => {
    it('buys at the cost-adjusted price and opens the position with its stop', async () => {
        const out = await executeEntry(ctx('dry_run'), entryArgs);
        const fill = 100 * 1.001;
        expect(q.insertTrade).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ side: 'buy', price: fill, quantity: 10 }),
        );
        expect(q.openPosition).toHaveBeenCalledWith(tx, {
            symbol: 'NVDA',
            side: 'long',
            quantity: 10,
            avgPrice: fill,
            stopPrice: 90,
        });
        expect(out.executed).toBe(true);
        expect(out.cashDebit).toBeCloseTo(fill * 10);
        expect(out.exposureDelta).toBeCloseTo(fill * 10);
    });

    it('never averages in — an open position means already_open', async () => {
        q.getOpenPositionBySymbol.mockResolvedValue({ id: 1 });
        const out = await executeEntry(ctx('dry_run'), entryArgs);
        expect(out.action).toBe('already_open');
        expect(q.insertTrade).not.toHaveBeenCalled();
    });
});

describe('executeEntry — semi_auto', () => {
    it('queues an approval, counts it as exposure, spends no cash', async () => {
        const out = await executeEntry(ctx('semi_auto'), entryArgs);
        expect(q.insertPendingOrder).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ side: 'buy', signalScore: 4.2 }),
        );
        expect(out).toEqual({ executed: false, exposureDelta: 1000, cashDebit: 0 });
    });
});

describe('executeEntry — auto', () => {
    it('fails closed without buying power and skips when cash is short', async () => {
        expect(
            (await executeEntry(ctx('auto'), { ...entryArgs, remainingBuyingPower: null })).action,
        ).toBe('skipped_no_buying_power');
        expect(
            (await executeEntry(ctx('auto'), { ...entryArgs, remainingBuyingPower: 999 })).action,
        ).toBe('skipped_insufficient_cash');
        expect(mockBuy).not.toHaveBeenCalled();
    });

    it('books a clean fill with the stop and debits the fill cost', async () => {
        mockBuy.mockResolvedValue({
            status: 'filled',
            avgFilledPrice: 101,
            filledQuantity: 10,
            orderId: 'o',
        });
        const out = await executeEntry(ctx('auto'), entryArgs);
        expect(q.createOrderTracking).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ idempotencyKey: 'exec-1-NVDA-buy' }),
        );
        expect(q.openPosition).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ avgPrice: 101, stopPrice: 90 }),
        );
        expect(q.updateOrderTracking).toHaveBeenCalledWith(
            tx,
            'exec-1-NVDA-buy',
            expect.objectContaining({ status: 'filled' }),
        );
        expect(out).toEqual({ executed: true, exposureDelta: 1010, cashDebit: 1010 });
    });

    it('merges a real fill into a position that appeared meanwhile', async () => {
        mockBuy.mockResolvedValue({ status: 'filled', avgFilledPrice: 101, filledQuantity: 10 });
        q.getOpenPositionBySymbol.mockResolvedValue({ id: 3 });
        await executeEntry(ctx('auto'), entryArgs);
        expect(q.averageIntoPosition).toHaveBeenCalledWith(tx, 3, 10, 101);
    });

    it('pending / partial debit the request price and book nothing; rejected debits nothing', async () => {
        mockBuy.mockResolvedValueOnce({ status: 'pending' });
        const pending = await executeEntry(ctx('auto'), entryArgs);
        expect(pending).toMatchObject({ action: 'order_submitted', cashDebit: 1000 });
        mockBuy.mockResolvedValueOnce({ status: 'partial', filledQuantity: 2 });
        expect((await executeEntry(ctx('auto'), entryArgs)).action).toBe('order_partial');
        mockBuy.mockResolvedValueOnce({ status: 'canceled' });
        expect(await executeEntry(ctx('auto'), entryArgs)).toMatchObject({
            action: 'order_rejected',
            cashDebit: 0,
        });
        mockBuy.mockResolvedValueOnce({ status: 'filled', avgFilledPrice: 101, filledQuantity: 9 });
        expect((await executeEntry(ctx('auto'), entryArgs)).action).toBe('needs_review');
        expect(q.insertTrade).not.toHaveBeenCalled();
    });

    it('marks tracking error and rethrows when the broker call throws', async () => {
        mockBuy.mockRejectedValueOnce(new Error('timeout'));
        await expect(executeEntry(ctx('auto'), entryArgs)).rejects.toThrow('timeout');
        expect(q.updateOrderTracking).toHaveBeenCalledWith(
            db,
            'exec-1-NVDA-buy',
            expect.objectContaining({ status: 'error' }),
        );
    });
});
