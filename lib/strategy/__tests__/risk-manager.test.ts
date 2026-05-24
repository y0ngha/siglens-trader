import { describe, it, expect } from 'vitest';
import { calculatePositionSize, shouldStopLoss, shouldTakeProfit } from '../risk-manager';

describe('calculatePositionSize', () => {
    describe('happy path', () => {
        it('calculates shares based on budget / price', () => {
            const result = calculatePositionSize({
                price: 100,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(100); // 10000 / 100
        });
    });

    describe('limits by maxPositionSize', () => {
        it('caps position size to maxPositionSize when exposure allows more', () => {
            const result = calculatePositionSize({
                price: 50,
                maxPositionSize: 5_000,
                maxTotalExposure: 100_000,
                currentExposure: 0,
            });
            // budget = min(5000, 100000) = 5000; shares = floor(5000/50) = 100
            expect(result).toBe(100);
        });
    });

    describe('limits by remaining exposure', () => {
        it('caps position size to remaining exposure when it is smaller', () => {
            const result = calculatePositionSize({
                price: 100,
                maxPositionSize: 20_000,
                maxTotalExposure: 50_000,
                currentExposure: 45_000,
            });
            // remaining = 50000 - 45000 = 5000; budget = min(20000, 5000) = 5000
            expect(result).toBe(50); // floor(5000/100)
        });
    });

    describe('uses the smaller of the two limits', () => {
        it('picks maxPositionSize when it is smaller than remaining exposure', () => {
            const result = calculatePositionSize({
                price: 25,
                maxPositionSize: 2_500,
                maxTotalExposure: 100_000,
                currentExposure: 0,
            });
            // budget = min(2500, 100000) = 2500; shares = floor(2500/25) = 100
            expect(result).toBe(100);
        });

        it('picks remaining exposure when it is smaller than maxPositionSize', () => {
            const result = calculatePositionSize({
                price: 25,
                maxPositionSize: 100_000,
                maxTotalExposure: 10_000,
                currentExposure: 7_500,
            });
            // remaining = 2500; budget = min(100000, 2500) = 2500; shares = floor(2500/25) = 100
            expect(result).toBe(100);
        });
    });

    describe('edge cases', () => {
        it('returns 0 when maxExposure fully consumed', () => {
            const result = calculatePositionSize({
                price: 100,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 50_000,
            });
            expect(result).toBe(0);
        });

        it('returns 0 when currentExposure exceeds maxTotalExposure', () => {
            const result = calculatePositionSize({
                price: 100,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 60_000,
            });
            expect(result).toBe(0);
        });

        it('returns 0 when price is 0 (avoid division by zero)', () => {
            const result = calculatePositionSize({
                price: 0,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(0);
        });

        it('returns 0 when price is negative', () => {
            const result = calculatePositionSize({
                price: -50,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(0);
        });

        it('handles fractional prices (e.g., $0.50 stock)', () => {
            const result = calculatePositionSize({
                price: 0.5,
                maxPositionSize: 1_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            // budget = min(1000, 50000) = 1000; shares = floor(1000/0.5) = 2000
            expect(result).toBe(2000);
        });
    });
});

describe('shouldStopLoss', () => {
    describe('triggers at exactly the threshold percentage', () => {
        it('returns true when loss equals stopLossPercent', () => {
            // avgPrice = 100, currentPrice = 95 → loss = 5%
            expect(shouldStopLoss(100, 95, 5)).toBe(true);
        });
    });

    describe('triggers above threshold', () => {
        it('returns true when loss exceeds stopLossPercent', () => {
            // avgPrice = 100, currentPrice = 90 → loss = 10%
            expect(shouldStopLoss(100, 90, 5)).toBe(true);
        });
    });

    describe('does NOT trigger below threshold', () => {
        it('returns false when loss is below stopLossPercent', () => {
            // avgPrice = 100, currentPrice = 97 → loss = 3%
            expect(shouldStopLoss(100, 97, 5)).toBe(false);
        });

        it('returns false when price has not dropped', () => {
            expect(shouldStopLoss(100, 100, 5)).toBe(false);
        });

        it('returns false when price has increased', () => {
            expect(shouldStopLoss(100, 110, 5)).toBe(false);
        });
    });

    describe('works with large prices', () => {
        it('triggers stop loss on expensive stock', () => {
            // avgPrice = 5000, currentPrice = 4500 → loss = 10%
            expect(shouldStopLoss(5000, 4500, 10)).toBe(true);
        });
    });

    describe('works with small prices', () => {
        it('triggers stop loss on penny stock', () => {
            // avgPrice = 0.10, currentPrice = 0.08 → loss = 20%
            expect(shouldStopLoss(0.1, 0.08, 20)).toBe(true);
        });
    });

    describe('edge: 0% threshold', () => {
        it('triggers when price drops at all', () => {
            expect(shouldStopLoss(100, 99.99, 0)).toBe(true);
        });

        it('triggers even when price is unchanged (0% loss meets 0% threshold)', () => {
            expect(shouldStopLoss(100, 100, 0)).toBe(true);
        });

        it('does not trigger when price has increased', () => {
            expect(shouldStopLoss(100, 100.01, 0)).toBe(false);
        });
    });
});

describe('shouldTakeProfit', () => {
    describe('triggers at exactly the threshold percentage', () => {
        it('returns true when gain equals takeProfitPercent', () => {
            // avgPrice = 100, currentPrice = 110 → gain = 10%
            expect(shouldTakeProfit(100, 110, 10)).toBe(true);
        });
    });

    describe('triggers above threshold', () => {
        it('returns true when gain exceeds takeProfitPercent', () => {
            // avgPrice = 100, currentPrice = 120 → gain = 20%
            expect(shouldTakeProfit(100, 120, 10)).toBe(true);
        });
    });

    describe('does NOT trigger below threshold', () => {
        it('returns false when gain is below takeProfitPercent', () => {
            // avgPrice = 100, currentPrice = 105 → gain = 5%
            expect(shouldTakeProfit(100, 105, 10)).toBe(false);
        });

        it('returns false when price is unchanged', () => {
            expect(shouldTakeProfit(100, 100, 10)).toBe(false);
        });

        it('returns false when price has decreased', () => {
            expect(shouldTakeProfit(100, 90, 10)).toBe(false);
        });
    });

    describe('works with large gains', () => {
        it('triggers take profit on massive gain', () => {
            // avgPrice = 50, currentPrice = 150 → gain = 200%
            expect(shouldTakeProfit(50, 150, 100)).toBe(true);
        });
    });

    describe('edge: 0% threshold', () => {
        it('triggers when price rises at all', () => {
            expect(shouldTakeProfit(100, 100.01, 0)).toBe(true);
        });

        it('triggers even when price is unchanged (0% gain meets 0% threshold)', () => {
            expect(shouldTakeProfit(100, 100, 0)).toBe(true);
        });

        it('does not trigger when price has decreased', () => {
            expect(shouldTakeProfit(100, 99.99, 0)).toBe(false);
        });
    });
});
