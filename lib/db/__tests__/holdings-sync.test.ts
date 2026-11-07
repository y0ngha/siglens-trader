import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    actionableItems,
    applyHoldingsSync,
    diffHoldings,
    hashSyncItems,
    HoldingsSyncConflictError,
    quantityMismatchMessages,
    type BrokerHoldingLike,
    type HoldingsSyncItem,
} from '../holdings-sync';
import { openPosition } from '../queries';
import type { Db } from '../index';

vi.mock('../queries', () => ({
    openPosition: vi.fn().mockResolvedValue([{ id: 99 }]),
}));
const mockOpenPosition = vi.mocked(openPosition);

const us = (symbol: string, quantity: number, avgPrice: number): BrokerHoldingLike => ({
    symbol,
    quantity,
    avgPrice,
    currency: 'USD',
    marketCountry: 'US',
});
const pos = (id: number, symbol: string, quantity: number, avgPrice: string) => ({
    id,
    symbol,
    quantity,
    avgPrice,
});
const managed = new Set(['AAPL', 'NVDA', 'AMD', 'ARM']);

describe('diffHoldings', () => {
    it('returns nothing when quantity and avg price match within tolerance', () => {
        const items = diffHoldings(
            [pos(1, 'AAPL', 5, '189.50')],
            [us('AAPL', 5.004, 189.504)],
            managed,
        );
        expect(items).toEqual([]);
    });

    it('updates quantity and avg price to the broker values', () => {
        const [it] = diffHoldings([pos(1, 'AAPL', 5, '189.50')], [us('AAPL', 6, 188.1)], managed);
        expect(it).toEqual({
            action: 'update',
            symbol: 'AAPL',
            positionId: 1,
            db: { quantity: 5, avgPrice: 189.5 },
            broker: { quantity: 6, avgPrice: 188.1 },
            brokerQuantity: 6,
            quantityMismatch: true,
        });
    });

    it('updates avg price only when quantity matches (not a quantity mismatch)', () => {
        const [it] = diffHoldings([pos(1, 'AAPL', 5, '189.50')], [us('AAPL', 5, 190)], managed);
        expect(it).toMatchObject({
            action: 'update',
            quantityMismatch: false,
            broker: { quantity: 5, avgPrice: 190 },
        });
        expect(quantityMismatchMessages([it!])).toEqual([]);
    });

    it('keeps the DB avg price when the broker avg price is unreadable (0)', () => {
        const [it] = diffHoldings([pos(1, 'AAPL', 5, '189.50')], [us('AAPL', 7, 0)], managed);
        expect(it).toMatchObject({ broker: { quantity: 7, avgPrice: 189.5 } });
    });

    it('closes a DB position the broker does not hold', () => {
        const [it] = diffHoldings([pos(2, 'NVDA', 3, '875.20')], [], managed);
        expect(it).toMatchObject({ action: 'close', positionId: 2, brokerQuantity: 0 });
    });

    it('closes when the broker holds only a fractional share (integer ledger)', () => {
        const [it] = diffHoldings([pos(2, 'NVDA', 3, '875.20')], [us('NVDA', 0.4, 870)], managed);
        expect(it).toMatchObject({ action: 'close', brokerQuantity: 0.4 });
    });

    it('flags a fractional-only quantity difference but has nothing to apply', () => {
        const items = diffHoldings([pos(1, 'AAPL', 3, '100')], [us('AAPL', 3.4, 100)], managed);
        expect(items).toHaveLength(1);
        expect(quantityMismatchMessages(items)).toEqual(['AAPL: DB 3주 vs 브로커 3.4주 (불일치)']);
        expect(actionableItems(items)).toEqual([]);
    });

    it('opens a position for a managed broker-only holding, floored', () => {
        const [it] = diffHoldings([], [us('AMD', 4.7, 150.25)], managed);
        expect(it).toEqual({
            action: 'open',
            symbol: 'AMD',
            broker: { quantity: 4, avgPrice: 150.25 },
        });
    });

    it('ignores unmanaged, non-US, sub-share and priceless broker holdings', () => {
        const items = diffHoldings(
            [],
            [
                us('QQQM', 10, 200),
                { symbol: 'ARM', quantity: 3, avgPrice: 100, currency: 'KRW', marketCountry: 'KR' },
                us('NVDA', 0.5, 800),
                us('AAPL', 2, 0),
            ],
            managed,
        );
        expect(items).toEqual([]);
    });

    it('accepts US holdings identified by country only', () => {
        const items = diffHoldings(
            [],
            [{ symbol: 'AMD', quantity: 1, avgPrice: 10, currency: '', marketCountry: 'US' }],
            managed,
        );
        expect(items).toHaveLength(1);
    });

    it('sorts by symbol', () => {
        const items = diffHoldings([pos(1, 'NVDA', 1, '1')], [us('AMD', 1, 1)], managed);
        expect(items.map((i) => i.symbol)).toEqual(['AMD', 'NVDA']);
    });
});

describe('quantityMismatchMessages', () => {
    it('keeps the reconcile wording for every kind', () => {
        const items = diffHoldings(
            [pos(1, 'AAPL', 5, '1'), pos(2, 'NVDA', 3, '1')],
            [us('AAPL', 6, 1), us('AMD', 2, 5)],
            managed,
        );
        expect(quantityMismatchMessages(items)).toEqual(
            [
                'AMD: 브로커 2주 보유 but DB 포지션 없음',
                'AAPL: DB 5주 vs 브로커 6주 (불일치)',
                'NVDA: DB 3주 vs 브로커 0주 (불일치)',
            ].sort((a, b) => a.localeCompare(b)),
        );
    });
});

describe('hashSyncItems', () => {
    const a: HoldingsSyncItem = {
        action: 'open',
        symbol: 'AMD',
        broker: { quantity: 1, avgPrice: 1 },
    };
    const b: HoldingsSyncItem = {
        action: 'open',
        symbol: 'ARM',
        broker: { quantity: 2, avgPrice: 1 },
    };
    it('is order independent', () => {
        expect(hashSyncItems([a, b])).toBe(hashSyncItems([b, a]));
    });
    it('changes when an item changes', () => {
        expect(hashSyncItems([a])).not.toBe(
            hashSyncItems([{ ...a, broker: { quantity: 2, avgPrice: 1 } }]),
        );
    });
    it('ignores non-actionable items', () => {
        const frac = diffHoldings([pos(1, 'AAPL', 3, '100')], [us('AAPL', 3.4, 100)], managed);
        expect(hashSyncItems(frac)).toBe(hashSyncItems([]));
    });
});

describe('applyHoldingsSync', () => {
    let returning: ReturnType<typeof vi.fn>;
    let set: ReturnType<typeof vi.fn>;
    let tx: unknown;
    let db: Db;

    beforeEach(() => {
        mockOpenPosition.mockReset().mockResolvedValue([{ id: 99 }] as never);
        returning = vi.fn().mockResolvedValue([{ id: 1 }]);
        set = vi.fn(() => ({ where: () => ({ returning }) }));
        tx = { update: vi.fn(() => ({ set })) };
        db = {
            transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        } as unknown as Db;
    });

    const update: HoldingsSyncItem = {
        action: 'update',
        symbol: 'AAPL',
        positionId: 1,
        db: { quantity: 5, avgPrice: 189.5 },
        broker: { quantity: 6, avgPrice: 188.1 },
        brokerQuantity: 6,
        quantityMismatch: true,
    };
    const close: HoldingsSyncItem = {
        action: 'close',
        symbol: 'NVDA',
        positionId: 2,
        db: { quantity: 3, avgPrice: 875.2 },
        brokerQuantity: 0,
    };
    const open: HoldingsSyncItem = {
        action: 'open',
        symbol: 'AMD',
        broker: { quantity: 4, avgPrice: 150 },
    };

    it('applies update, close and open', async () => {
        await expect(applyHoldingsSync(db, [update, close, open])).resolves.toEqual({ applied: 3 });
        expect(set).toHaveBeenCalledWith({ quantity: 6, avgPrice: '188.1' });
        expect(set).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'closed', closePrice: null }),
        );
        expect(mockOpenPosition).toHaveBeenCalledWith(tx, {
            symbol: 'AMD',
            side: 'long',
            quantity: 4,
            avgPrice: 150,
            stopPrice: null,
        });
    });

    it('skips non-actionable items', async () => {
        const frac = { ...update, broker: { ...update.db } };
        await expect(applyHoldingsSync(db, [frac])).resolves.toEqual({ applied: 0 });
        expect(set).not.toHaveBeenCalled();
    });

    it('throws a conflict when an update matches no row', async () => {
        returning.mockResolvedValueOnce([]);
        await expect(applyHoldingsSync(db, [update])).rejects.toBeInstanceOf(
            HoldingsSyncConflictError,
        );
    });

    it('throws a conflict when a close matches no row', async () => {
        returning.mockResolvedValueOnce([]);
        await expect(applyHoldingsSync(db, [close])).rejects.toBeInstanceOf(
            HoldingsSyncConflictError,
        );
    });

    it('maps a unique violation on open to a conflict', async () => {
        mockOpenPosition.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
        await expect(applyHoldingsSync(db, [open])).rejects.toBeInstanceOf(
            HoldingsSyncConflictError,
        );
    });

    it('rethrows other open errors', async () => {
        mockOpenPosition.mockRejectedValueOnce(new Error('boom'));
        await expect(applyHoldingsSync(db, [open])).rejects.toThrow('boom');
    });
});
