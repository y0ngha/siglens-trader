import { describe, it, expect } from 'vitest';
import { realizedPnlForSell } from '../pnl';

describe('realizedPnlForSell', () => {
    it('returns positive PnL when sellPrice > avgPrice (profit)', () => {
        // (200 - 150) * 3 = 150
        expect(realizedPnlForSell(200, 150, 3)).toBe(150);
    });

    it('returns negative PnL when sellPrice < avgPrice (loss)', () => {
        // (100 - 150) * 3 = -150
        expect(realizedPnlForSell(100, 150, 3)).toBe(-150);
    });

    it('returns 0 for break-even (sellPrice === avgPrice)', () => {
        expect(realizedPnlForSell(100, 100, 5)).toBe(0);
    });

    it('rounds to cents — eliminates float noise (10.1 - 10) * 3', () => {
        // Raw: (10.1 - 10) * 3 = 0.30000000000000004
        expect(realizedPnlForSell(10.1, 10, 3)).toBe(0.3);
    });

    it('handles a clean decimal (47.5 - 0) * 1 = 47.5', () => {
        expect(realizedPnlForSell(47.5, 0, 1)).toBe(47.5);
    });

    it('handles quantity of 1 share', () => {
        expect(realizedPnlForSell(300, 250, 1)).toBe(50);
    });

    it('handles large quantities', () => {
        // (500 - 400) * 100 = 10000
        expect(realizedPnlForSell(500, 400, 100)).toBe(10000);
    });

    it('rounds sub-cent float noise correctly', () => {
        // (0.1 + 0.2) === 0.30000000000000004 in JS; ensure rounding handles it
        const sellPrice = 0.1 + 0.2; // 0.30000000000000004
        // (0.30000000000000004 - 0) * 1 → rounds to 0.3
        expect(realizedPnlForSell(sellPrice, 0, 1)).toBe(0.3);
    });
});
