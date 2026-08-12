import { describe, it, expect } from 'vitest';
import { clampFraction, fallbackEntryFraction, planEntry, planExit } from '../trade-plan';
import type { ExitTrigger } from '../trade-plan';

describe('clampFraction', () => {
    it('returns the value unchanged when already within [min, 1]', () => {
        expect(clampFraction(0.5, 0, 1)).toBe(0.5);
    });

    it('clamps up to min when below it', () => {
        expect(clampFraction(-0.2, 0, 1)).toBe(0);
    });

    it('clamps down to 1 when above it', () => {
        expect(clampFraction(1.5, 0, 1)).toBe(1);
    });

    it('falls back on NaN', () => {
        expect(clampFraction(NaN, 0, 0.7)).toBe(0.7);
    });

    it('falls back on Infinity', () => {
        expect(clampFraction(Infinity, 0, 0.7)).toBe(0.7);
    });

    it('falls back on a numeric string (not a number type)', () => {
        expect(clampFraction('0.5', 0, 0.7)).toBe(0.7);
    });

    it('falls back on null', () => {
        expect(clampFraction(null, 0, 0.7)).toBe(0.7);
    });

    it('falls back on undefined', () => {
        expect(clampFraction(undefined, 0, 0.7)).toBe(0.7);
    });

    it('falls back on an object', () => {
        expect(clampFraction({ value: 0.5 }, 0, 0.7)).toBe(0.7);
    });

    it('respects a non-zero min', () => {
        expect(clampFraction(0.1, 0.3, 1)).toBe(0.3);
    });

    it('clamps an out-of-range fallback too (fallback is not a trusted side door)', () => {
        // value is invalid (NaN) -> falls back to 5, but 5 is then clamped to 1.
        expect(clampFraction(NaN, 0.3, 5)).toBe(1);
    });
});

describe('fallbackEntryFraction', () => {
    it('returns 1/3 exactly at the buy threshold (conviction 0)', () => {
        expect(fallbackEntryFraction(70, 70)).toBeCloseTo(1 / 3);
    });

    it('returns 1/3 when score is below the threshold (conviction clamped to 0)', () => {
        expect(fallbackEntryFraction(50, 70)).toBeCloseTo(1 / 3);
    });

    it('returns 2/3 in the middle rung', () => {
        // headroom = max(1, 100-70) = 30; conviction = (85-70)/30 = 0.5 -> [1/3, 2/3)
        expect(fallbackEntryFraction(85, 70)).toBeCloseTo(2 / 3);
    });

    it('returns 1 (full size) at the top rung', () => {
        // conviction = (95-70)/30 = 0.833 -> >= 2/3
        expect(fallbackEntryFraction(95, 70)).toBe(1);
    });

    it('returns 1 when score exceeds 100 (conviction clamped to 1)', () => {
        expect(fallbackEntryFraction(150, 70)).toBe(1);
    });

    it('never divides by zero when buyThreshold >= 100', () => {
        // headroom = max(1, 100-100) = 1 -> no NaN/Infinity
        expect(Number.isFinite(fallbackEntryFraction(100, 100))).toBe(true);
        expect(fallbackEntryFraction(100, 100)).toBeCloseTo(1 / 3);
    });

    it('never divides by zero when buyThreshold > 100', () => {
        expect(Number.isFinite(fallbackEntryFraction(50, 105))).toBe(true);
    });

    it('returns 1/3 (weakest rung) for a NaN score rather than propagating NaN', () => {
        expect(fallbackEntryFraction(NaN, 70)).toBeCloseTo(1 / 3);
    });
});

describe('planEntry', () => {
    describe('budget constraint selection', () => {
        it('is limited by symbol budget when it is the smallest', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            expect(result.limitedBy).toBe('symbol');
            expect(result.fullBudget).toBe(100);
            expect(result.quantity).toBe(10);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('is limited by total exposure when it is the smallest', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100_000,
                maxTotalExposure: 500,
                currentExposure: 450,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            // totalBudget = 500-450 = 50, smallest of {100000, 50, 100000}
            expect(result.limitedBy).toBe('total');
            expect(result.fullBudget).toBe(50);
            expect(result.quantity).toBe(5);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('is limited by available cash when it is the smallest', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100_000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 30,
            });
            expect(result.limitedBy).toBe('cash');
            expect(result.fullBudget).toBe(30);
            expect(result.quantity).toBe(3);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('ties break symbol > total > cash when all three budgets are exactly equal', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100,
                maxTotalExposure: 100,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100,
            });
            expect(result.fullBudget).toBe(100);
            expect(result.limitedBy).toBe('symbol');
        });

        it('ties break total > cash when symbol budget is not the (tied) minimum', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 1000, // not tied, not the minimum
                maxTotalExposure: 100,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100,
            });
            expect(result.fullBudget).toBe(100);
            expect(result.limitedBy).toBe('total');
        });
    });

    describe('invalid price', () => {
        it('returns all-zero, limitedBy none when price is 0', () => {
            const result = planEntry({
                price: 0,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 1000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result).toEqual({
                quantity: 0,
                fullBudget: 0,
                trancheBudget: 0,
                limitedBy: 'none',
            });
        });

        it('returns all-zero when price is negative', () => {
            const result = planEntry({
                price: -50,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 1000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result.quantity).toBe(0);
            expect(result.limitedBy).toBe('none');
        });

        it('returns all-zero when price is NaN', () => {
            const result = planEntry({
                price: NaN,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 1000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result.quantity).toBe(0);
            expect(result.limitedBy).toBe('none');
        });

        it('treats an absurdly tiny (but finite) price as unsafe and returns 0 quantity', () => {
            const result = planEntry({
                price: 1e-300,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            // floor(1000 / 1e-300) = 1e+303, not a safe integer -> clamped to 0
            expect(result.quantity).toBe(0);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('treats Number.MIN_VALUE price (division -> Infinity) as unsafe and returns 0 quantity', () => {
            const result = planEntry({
                price: Number.MIN_VALUE,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result.quantity).toBe(0);
            expect(Number.isFinite(result.quantity)).toBe(true);
        });
    });

    describe('fraction handling', () => {
        const base = {
            price: 10,
            maxPositionSize: 1000,
            maxTotalExposure: 100_000,
            currentExposure: 0,
            existingSymbolExposure: 0,
        };

        it('fraction 0 yields 0 quantity and does NOT trigger the high-price correction', () => {
            const result = planEntry({ ...base, fraction: 0 });
            expect(result.quantity).toBe(0);
            expect(result.trancheBudget).toBe(0);
        });

        it('fraction 0.5 halves the tranche budget', () => {
            const result = planEntry({ ...base, fraction: 0.5 });
            expect(result.trancheBudget).toBe(500);
            expect(result.quantity).toBe(50); // floor(500/10)
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('fraction 1 uses the full budget', () => {
            const result = planEntry({ ...base, fraction: 1 });
            expect(result.trancheBudget).toBe(1000);
            expect(result.quantity).toBe(100);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('NaN fraction falls back to 1 (full tranche), not NaN quantity', () => {
            const result = planEntry({ ...base, fraction: NaN });
            expect(result.trancheBudget).toBe(1000);
            expect(result.quantity).toBe(100);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });
    });

    describe('high-price correction', () => {
        it('bumps 0 quantity up to 1 share when the fraction budget cannot cover one share but full budget can', () => {
            const result = planEntry({
                price: 500,
                fraction: 0.33,
                maxPositionSize: 1000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            // trancheBudget = 330, floor(330/500) = 0, but fullBudget(1000) >= price(500)
            expect(result.quantity).toBe(1);
            // trancheBudget is realigned to what actually gets spent (1 share @ $500),
            // not left at the pre-bump $330 slice.
            expect(result.trancheBudget).toBe(500);
        });

        it('does not bump when fullBudget itself is below price (cannot even afford one share)', () => {
            const result = planEntry({
                price: 500,
                fraction: 1,
                maxPositionSize: 200,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result.fullBudget).toBe(200);
            expect(result.quantity).toBe(0);
        });
    });

    describe('availableCash', () => {
        it('treats null availableCash as unconstrained', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: null,
            });
            expect(result.limitedBy).toBe('symbol');
            expect(result.quantity).toBe(10);
        });

        it('treats undefined (omitted) availableCash as unconstrained', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(result.limitedBy).toBe('symbol');
            expect(result.quantity).toBe(10);
        });
    });

    describe('existing position already at the symbol cap', () => {
        it('returns 0 quantity, limitedBy symbol', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 100_000,
                currentExposure: 1000,
                existingSymbolExposure: 1000,
                availableCash: 100_000,
            });
            expect(result.limitedBy).toBe('symbol');
            expect(result.fullBudget).toBe(0);
            expect(result.quantity).toBe(0);
        });
    });

    describe('malformed budget inputs never produce a non-finite/unsafe quantity', () => {
        it('NaN maxPositionSize is sanitized to 0 (fails closed, does not disable the cap)', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: NaN,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            expect(result.quantity).toBe(0);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
            expect(Number.isFinite(result.fullBudget)).toBe(true);
        });

        it('NaN maxTotalExposure is sanitized to 0', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: NaN,
                currentExposure: 0,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            expect(result.quantity).toBe(0);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
            expect(Number.isFinite(result.fullBudget)).toBe(true);
        });

        it('NaN existingSymbolExposure is sanitized to 0 rather than poisoning symbolBudget', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 1000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
                existingSymbolExposure: NaN,
                availableCash: 100_000,
            });
            // symbolBudget = max(0, 1000 - 0) = 1000 (NaN treated as "no existing exposure")
            expect(result.limitedBy).toBe('symbol');
            expect(result.fullBudget).toBe(1000);
            expect(result.quantity).toBe(100);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('NaN currentExposure is sanitized to 0 rather than poisoning totalBudget', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: 100_000,
                maxTotalExposure: 500,
                currentExposure: NaN,
                existingSymbolExposure: 0,
                availableCash: 100_000,
            });
            // totalBudget = max(0, 500 - 0) = 500
            expect(result.limitedBy).toBe('total');
            expect(result.fullBudget).toBe(500);
            expect(result.quantity).toBe(50);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
        });

        it('Infinity maxPositionSize and maxTotalExposure never yield an Infinity quantity', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: Infinity,
                maxTotalExposure: Infinity,
                currentExposure: 0,
                existingSymbolExposure: 0,
            });
            expect(Number.isFinite(result.quantity)).toBe(true);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
            expect(Number.isFinite(result.fullBudget)).toBe(true);
        });

        it('all budget inputs NaN at once still produces a finite, safe-integer quantity', () => {
            const result = planEntry({
                price: 10,
                fraction: 1,
                maxPositionSize: NaN,
                maxTotalExposure: NaN,
                currentExposure: NaN,
                existingSymbolExposure: NaN,
            });
            expect(result.quantity).toBe(0);
            expect(Number.isSafeInteger(result.quantity)).toBe(true);
            expect(Number.isFinite(result.fullBudget)).toBe(true);
            expect(Number.isFinite(result.trancheBudget)).toBe(true);
        });
    });
});

describe('planExit', () => {
    it('hard exit liquidates the full position regardless of fraction', () => {
        const quantity = planExit({
            positionQuantity: 37,
            fraction: 0.1,
            trigger: 'stop_loss',
            hard: true,
        });
        expect(quantity).toBe(37);
        expect(Number.isSafeInteger(quantity)).toBe(true);
    });

    it('hard exit liquidates in full even when fraction is exactly 0', () => {
        // hard must win over the fraction===0 "defer" path.
        const quantity = planExit({
            positionQuantity: 37,
            fraction: 0,
            trigger: 'stop_loss',
            hard: true,
        });
        expect(quantity).toBe(37);
    });

    it('fraction 0 defers the exit (returns 0)', () => {
        const quantity = planExit({ positionQuantity: 100, fraction: 0, trigger: 'signal_sell' });
        expect(quantity).toBe(0);
    });

    it('a negative fraction clamps to 0 and defers the exit, same as an exact 0', () => {
        const quantity = planExit({
            positionQuantity: 100,
            fraction: -5,
            trigger: 'signal_sell',
        });
        expect(quantity).toBe(0);
    });

    it('fraction 0.5 on an odd holding rounds down', () => {
        // floor(37 * 0.5) = 18
        const quantity = planExit({
            positionQuantity: 37,
            fraction: 0.5,
            trigger: 'take_profit',
        });
        expect(quantity).toBe(18);
        expect(Number.isSafeInteger(quantity)).toBe(true);
    });

    it('fraction 1 sells the entire position', () => {
        const quantity = planExit({ positionQuantity: 42, fraction: 1, trigger: 'take_profit' });
        expect(quantity).toBe(42);
        expect(Number.isSafeInteger(quantity)).toBe(true);
    });

    it('1 share held with a small fraction still sells at least 1 (floor lower bound)', () => {
        // floor(1 * 0.1) = 0, but the >=1 floor kicks in since fraction !== 0
        const quantity = planExit({
            positionQuantity: 1,
            fraction: 0.1,
            trigger: 'signal_sell',
        });
        expect(quantity).toBe(1);
    });

    it('returns 0 when holding is 0', () => {
        expect(planExit({ positionQuantity: 0, fraction: 1, trigger: 'signal_sell' })).toBe(0);
    });

    it('returns 0 when holding is negative', () => {
        expect(planExit({ positionQuantity: -5, fraction: 1, trigger: 'signal_sell' })).toBe(0);
    });

    it('returns 0 when holding is NaN', () => {
        expect(planExit({ positionQuantity: NaN, fraction: 1, trigger: 'signal_sell' })).toBe(0);
    });

    it('floors a fractional holding before applying fraction', () => {
        // total = floor(10.9) = 10; floor(10*1) = 10
        const quantity = planExit({
            positionQuantity: 10.9,
            fraction: 1,
            trigger: 'signal_sell',
        });
        expect(quantity).toBe(10);
        expect(Number.isSafeInteger(quantity)).toBe(true);
    });

    it('NaN fraction falls back to a full liquidation, not a NaN quantity', () => {
        const quantity = planExit({ positionQuantity: 20, fraction: NaN, trigger: 'signal_sell' });
        expect(quantity).toBe(20);
        expect(Number.isSafeInteger(quantity)).toBe(true);
    });

    it('Infinity fraction clamps to 1 (full liquidation)', () => {
        const quantity = planExit({
            positionQuantity: 20,
            fraction: Infinity,
            trigger: 'signal_sell',
        });
        expect(quantity).toBe(20);
    });

    it('trigger is optional — omitting it does not change the result', () => {
        expect(planExit({ positionQuantity: 20, fraction: 0.5 })).toBe(10);
    });

    describe('trigger does not influence sizing (no hidden per-trigger floor)', () => {
        const triggers: ExitTrigger[] = ['stop_loss', 'take_profit', 'signal_sell'];

        it.each(triggers)('same fraction yields the same quantity for trigger=%s', (trigger) => {
            const quantity = planExit({ positionQuantity: 37, fraction: 0.4, trigger });
            expect(quantity).toBe(14); // floor(37 * 0.4) = 14, identical for every trigger
        });
    });
});
