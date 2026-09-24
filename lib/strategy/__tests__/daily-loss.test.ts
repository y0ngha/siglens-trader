import { describe, it, expect } from 'vitest';
import { todayUnrealizedChange, MAX_QUOTE_DIVERGENCE, type HeldPosition } from '../daily-loss';

const pos = (o: Partial<HeldPosition> = {}): HeldPosition => ({
    symbol: 'A',
    quantity: 10,
    avgPrice: 100,
    openedDate: '2026-01-01',
    ...o,
});
const TODAY = '2026-01-05';

describe('todayUnrealizedChange', () => {
    it('a carried position is measured against the previous close, not the entry', () => {
        const r = todayUnrealizedChange(
            [pos()],
            new Map([['A', { price: 95, previousClose: 98 }]]),
            TODAY,
        );
        expect(r.total).toBeCloseTo(-30);
        expect(r.missingPrice).toEqual([]);
        expect(r.divergent).toEqual([]);
    });

    it('a position opened today is measured against its entry price', () => {
        const r = todayUnrealizedChange(
            [pos({ openedDate: TODAY })],
            new Map([['A', { price: 95, previousClose: 98 }]]),
            TODAY,
        );
        expect(r.total).toBeCloseTo(-50);
    });

    it('a missing previous close falls back to the entry price (substitute, never exclude)', () => {
        const r = todayUnrealizedChange(
            [pos()],
            new Map([['A', { price: 95, previousClose: null }]]),
            TODAY,
        );
        expect(r.total).toBeCloseTo(-50);
    });

    it('a missing price contributes 0 and is reported', () => {
        const r = todayUnrealizedChange(
            [pos(), pos({ symbol: 'B', avgPrice: 0 })],
            new Map(),
            TODAY,
        );
        expect(r.total).toBe(0);
        expect(r.missingPrice).toEqual(['A', 'B']);
    });

    it('a price far from its reference is treated as a corrupt quote', () => {
        const r = todayUnrealizedChange(
            [pos()],
            new Map([['A', { price: 10, previousClose: 100 }]]),
            TODAY,
        );
        expect(r.total).toBe(0);
        expect(r.divergent).toEqual(['A']);
        expect(MAX_QUOTE_DIVERGENCE).toBe(0.25);
    });

    it('sums across positions', () => {
        const r = todayUnrealizedChange(
            [pos(), pos({ symbol: 'B', quantity: 2 })],
            new Map([
                ['A', { price: 101, previousClose: 100 }],
                ['B', { price: 90, previousClose: 100 }],
            ]),
            TODAY,
        );
        expect(r.total).toBeCloseTo(10 - 20);
    });
});
