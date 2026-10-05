import { describe, it, expect } from 'vitest';
import {
    ABS_MAX_POSITION_USD,
    ABS_MAX_TOTAL_EXPOSURE_USD,
    MAX_SLOTS,
    accountEquity,
    carriedSlots,
    deriveSizing,
    slotsFromPrices,
} from '../sizing';

/** 2026-10-05 FMP 시세, 감시 종목 39개(스펙 §2 실측 표의 입력). */
const UNIVERSE_2026_10_05 = [
    633.91, 333.69, 517.53, 728.08, 251.52, 343.5, 355.14, 183, 160.01, 43.69, 73.92, 112.74,
    769.64, 749.58, 233.95, 370.59, 188.75, 1074.89, 472.78, 1867.31, 272.29, 347.49, 540.04,
    184.87, 307.49, 207.35, 67.06, 234.69, 237.69, 134.38, 151.39, 68.11, 270.04, 403.24, 341.04,
    348.96, 277.22, 196.6, 268.22,
];
const kAt = (equity: number) =>
    slotsFromPrices(equity, UNIVERSE_2026_10_05, UNIVERSE_2026_10_05.length, null);

describe('slotsFromPrices — 감시 종목 주가 커버리지로 칸 수', () => {
    it.each([
        [10, 1],
        [100, 1],
        [300, 1],
        [500, 1],
        [1000, 2],
        [1500, 3],
        [2000, 4],
        [3000, 7],
        [4000, 8],
        [25_000, 8],
        [100_000, 8],
    ])('스펙 §2 실측 표: 총자산 $%d → %d칸', (equity, slots) => {
        const r = kAt(equity);
        expect(r.slots).toBe(slots);
        expect(r.source).toBe('prices');
        expect(r.priceCount).toBe(39);
    });

    it('고른 K의 커버리지는 목표 이상, K+1은 미만', () => {
        const r = kAt(2000);
        expect(r.coverage).toBeGreaterThanOrEqual(0.75);
        const next = UNIVERSE_2026_10_05.filter((p) => p <= 2000 / 5).length / 39;
        expect(next).toBeLessThan(0.75);
    });

    it('커버리지가 정확히 0.75면 그 K를 고른다', () => {
        // 가격 4개 중 3개가 $100 이하 → 총자산 $800, K=8이면 칸 $100 = 정확히 75%.
        const r = slotsFromPrices(800, [50, 80, 100, 500], 4, null);
        expect(r).toEqual({ slots: 8, source: 'prices', coverage: 0.75, priceCount: 4 });
    });

    it('어느 K로도 목표에 못 미치면 1칸, 그때의 커버리지를 남긴다', () => {
        const r = slotsFromPrices(300, UNIVERSE_2026_10_05, 39, 5);
        expect(r.slots).toBe(1);
        expect(r.source).toBe('prices');
        expect(r.coverage).toBeCloseTo(21 / 39);
    });

    it('총자산 0·음수·NaN은 1칸 — 어차피 살 수 없다', () => {
        for (const eq of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
            const r = slotsFromPrices(eq, [10, 20], 2, null);
            expect(r.slots).toBe(1);
            expect(r.source).toBe('prices');
            expect(r.coverage).toBe(0);
        }
    });

    it('양수·유한이 아닌 가격(조회 실패)은 표본에서 뺀다', () => {
        const r = slotsFromPrices(
            800,
            [50, null, 80, Number.NaN, -1, 0, Number.POSITIVE_INFINITY, '90', 100],
            4,
            null,
        );
        expect(r.priceCount).toBe(3);
        expect(r.slots).toBe(8);
        expect(r.coverage).toBe(1);
    });

    it('표본이 감시 종목의 절반 미만이면 마지막 기록의 K를 이어 쓴다', () => {
        const prices = [100, 200, null, null, null];
        expect(slotsFromPrices(10_000, prices, 5, 3)).toEqual({
            slots: 3,
            source: 'carried',
            coverage: null,
            priceCount: 0,
        });
        // 기록도 없으면 MAX_SLOTS.
        expect(slotsFromPrices(10_000, prices, 5, null)).toMatchObject({
            slots: MAX_SLOTS,
            source: 'default',
        });
    });

    it('표본이 정확히 절반이면 시세로 계산한다', () => {
        expect(slotsFromPrices(10_000, [100, 200, null, null], 4, 3).source).toBe('prices');
    });

    it('감시 종목이 없거나 가격이 하나도 없으면 carried/default', () => {
        expect(slotsFromPrices(10_000, [], 0, null).source).toBe('default');
        expect(slotsFromPrices(10_000, [null], 1, 6)).toMatchObject({
            slots: 6,
            source: 'carried',
        });
        expect(slotsFromPrices(10_000, [], -3, null).source).toBe('default');
    });
});

describe('carriedSlots', () => {
    it('1~8 정수만 이어 쓰고, 나머지는 MAX_SLOTS(default)', () => {
        expect(carriedSlots(1)).toMatchObject({ slots: 1, source: 'carried' });
        expect(carriedSlots(8)).toMatchObject({ slots: 8, source: 'carried' });
        for (const bad of [null, 0, 9, 2.5, Number.NaN, -1]) {
            expect(carriedSlots(bad)).toEqual({
                slots: MAX_SLOTS,
                source: 'default',
                coverage: null,
                priceCount: 0,
            });
        }
    });
});

describe('deriveSizing — 금액 한도는 총자산에서', () => {
    const prices = (slots: number) =>
        ({ slots, source: 'prices', coverage: 0.8, priceCount: 39 }) as const;

    it('$25,000·8칸: 칸 $3,125, 총 노출 $25,000, 손실 한도 $500(= 종전 설정, 총자산 2%)', () => {
        expect(deriveSizing(25_000, prices(8))).toEqual({
            equity: 25_000,
            slots: 8,
            slotsSource: 'prices',
            coverage: 0.8,
            priceCount: 39,
            slotBudget: 3125,
            maxPositionSize: 3125,
            maxTotalExposure: 25_000,
            dailyLossLimit: 500,
        });
    });

    it('$2,000·4칸: 칸 $500, 손실 한도 $80(총자산 4%)', () => {
        const s = deriveSizing(2000, prices(4));
        expect(s.slotBudget).toBe(500);
        expect(s.maxPositionSize).toBe(500);
        expect(s.maxTotalExposure).toBe(2000);
        expect(s.dailyLossLimit).toBeCloseTo(80);
    });

    it('총자산이 터무니없어도(1e9) 절대 상한이 묶는다 — 손실 한도도 함께', () => {
        const s = deriveSizing(1e9, prices(8));
        expect(s.maxPositionSize).toBe(ABS_MAX_POSITION_USD);
        expect(s.maxTotalExposure).toBe(ABS_MAX_TOTAL_EXPOSURE_USD);
        expect(s.dailyLossLimit).toBe(4000);
        expect(s.slotBudget).toBe(1e9 / 8);
    });

    it('NaN·음수 총자산은 한도를 끄지 않고 0으로 만든다', () => {
        for (const eq of [Number.NaN, -500, Number.POSITIVE_INFINITY]) {
            const s = deriveSizing(eq, prices(4));
            expect(s.equity).toBe(0);
            expect(s.slotBudget).toBe(0);
            expect(s.maxPositionSize).toBe(0);
            expect(s.maxTotalExposure).toBe(0);
            expect(s.dailyLossLimit).toBe(0);
        }
    });

    it('손상된 칸 수는 MAX_SLOTS로', () => {
        expect(deriveSizing(800, { ...prices(4), slots: 0 }).slots).toBe(MAX_SLOTS);
        expect(deriveSizing(800, { ...prices(4), slots: 2.5 }).slotBudget).toBe(100);
    });
});

describe('accountEquity', () => {
    it('현금 + 보유 평가액(실시간 가격, 없으면 평단)', () => {
        expect(
            accountEquity(1000, [
                { quantity: 2, avgPrice: 100, price: 150 },
                { quantity: 3, avgPrice: 50, price: 0 },
            ]),
        ).toBe(1000 + 300 + 150);
    });

    it('현금을 모르면 null', () => {
        expect(accountEquity(null, [{ quantity: 1, avgPrice: 1, price: 1 }])).toBeNull();
        expect(accountEquity(Number.NaN, [])).toBeNull();
    });

    it('음수 현금·수량, NaN 평단·가격은 0으로 방어', () => {
        expect(
            accountEquity(-50, [
                { quantity: -2, avgPrice: 100, price: 100 },
                { quantity: Number.NaN, avgPrice: 100, price: 100 },
                { quantity: 1, avgPrice: Number.NaN, price: Number.NaN },
                { quantity: 1, avgPrice: -10, price: -5 },
            ]),
        ).toBe(0);
    });
});
