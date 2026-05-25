import { describe, it, expect } from 'vitest';
import {
    calculatePositionSize,
    shouldStopLoss,
    shouldTakeProfit,
    evaluateExistingPosition,
} from '../risk-manager';
import type { EvaluatePositionParams } from '../risk-manager';

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

        it('returns 0 when price is NaN', () => {
            const result = calculatePositionSize({
                price: NaN,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(0);
        });

        it('returns 0 when price is Infinity', () => {
            const result = calculatePositionSize({
                price: Infinity,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(0);
        });

        it('returns 0 when price is -Infinity', () => {
            const result = calculatePositionSize({
                price: -Infinity,
                maxPositionSize: 10_000,
                maxTotalExposure: 50_000,
                currentExposure: 0,
            });
            expect(result).toBe(0);
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

    describe('NaN / invalid input protection', () => {
        it('returns false when avgPrice is 0 (division by zero)', () => {
            expect(shouldStopLoss(0, 95, 5)).toBe(false);
        });

        it('returns false when avgPrice is NaN', () => {
            expect(shouldStopLoss(NaN, 95, 5)).toBe(false);
        });

        it('returns false when avgPrice is negative', () => {
            expect(shouldStopLoss(-100, 95, 5)).toBe(false);
        });

        it('returns false when avgPrice is Infinity', () => {
            expect(shouldStopLoss(Infinity, 95, 5)).toBe(false);
        });

        it('returns false when currentPrice is NaN', () => {
            expect(shouldStopLoss(100, NaN, 5)).toBe(false);
        });

        it('returns false when currentPrice is Infinity', () => {
            expect(shouldStopLoss(100, Infinity, 5)).toBe(false);
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

    describe('NaN / invalid input protection', () => {
        it('returns false when avgPrice is 0 (division by zero)', () => {
            expect(shouldTakeProfit(0, 110, 10)).toBe(false);
        });

        it('returns false when avgPrice is NaN', () => {
            expect(shouldTakeProfit(NaN, 110, 10)).toBe(false);
        });

        it('returns false when avgPrice is negative', () => {
            expect(shouldTakeProfit(-100, 110, 10)).toBe(false);
        });

        it('returns false when avgPrice is Infinity', () => {
            expect(shouldTakeProfit(Infinity, 110, 10)).toBe(false);
        });

        it('returns false when currentPrice is NaN', () => {
            expect(shouldTakeProfit(100, NaN, 10)).toBe(false);
        });

        it('returns false when currentPrice is Infinity', () => {
            expect(shouldTakeProfit(100, Infinity, 10)).toBe(false);
        });
    });
});

describe('evaluateExistingPosition', () => {
    const baseParams: EvaluatePositionParams = {
        avgPrice: 100,
        currentPrice: 100,
        stopLossPercent: 5,
        takeProfitPercent: 10,
    };

    const enabledParams: EvaluatePositionParams = {
        ...baseParams,
        fixedExitEnabled: true,
    };

    describe('fixedExitEnabled: false (default) — fixed checks skipped', () => {
        it('does NOT trigger fixed stop loss even when loss exceeds threshold', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 94, // -6% loss, threshold is 5%
            });
            expect(result.action).toBe('hold');
        });

        it('does NOT trigger fixed take profit even when gain exceeds threshold', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 112, // +12% gain, threshold is 10%
            });
            expect(result.action).toBe('hold');
        });

        it('dynamic checks still work when fixed exit is disabled', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 98,
                supportLevel: 99,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
        });
    });

    describe('fixedExitEnabled: true — fixed checks active', () => {
        it('returns stop_loss when loss exceeds stopLossPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 94, // -6% loss, threshold is 5%
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('고정 손절선');
            expect(result.reason).toContain('-5%');
        });

        it('returns stop_loss when loss exactly equals stopLossPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 95, // exactly -5%
            });
            expect(result.action).toBe('stop_loss');
        });

        it('returns take_profit when gain exceeds takeProfitPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 112, // +12% gain, threshold is 10%
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('고정 익절선');
            expect(result.reason).toContain('+10%');
        });

        it('returns take_profit when gain exactly equals takeProfitPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 110, // exactly +10%
            });
            expect(result.action).toBe('take_profit');
        });
    });

    describe('support level break triggers stop_loss', () => {
        it('returns stop_loss when price is below support level', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 98,
                supportLevel: 99,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
            expect(result.reason).toContain('$99');
            expect(result.reason).toContain('$98');
        });

        it('holds when price is above support level', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 100,
                supportLevel: 95,
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('technical trend reversal triggers stop_loss', () => {
        it('returns stop_loss when trend is bearish', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 100, // no loss
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('기술적 추세 반전');
        });

        it('does not trigger for neutral trend', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                technicalTrend: 'neutral',
            });
            expect(result.action).toBe('hold');
        });

        it('does not trigger for bullish trend', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                technicalTrend: 'bullish',
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('resistance approach triggers take_profit', () => {
        it('returns take_profit when price is within 2% of resistance', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 108, // +8% (below fixed take profit)
                resistanceLevel: 110, // 108 >= 110 * 0.98 (=107.8)
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('저항선 근접');
            expect(result.reason).toContain('$110');
        });

        it('holds when price is far from resistance', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105, // +5% gain
                resistanceLevel: 120, // 105 < 120 * 0.98 (=117.6)
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('target price approach triggers take_profit', () => {
        it('returns take_profit when price is within 5% of target', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 108, // below fixed TP
                targetPrice: 112, // 108 >= 112 * 0.95 (=106.4)
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('목표가 근접');
            expect(result.reason).toContain('$112');
        });

        it('holds when price is far from target', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 102,
                targetPrice: 130, // 102 < 130 * 0.95 (=123.5)
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('bearish news with profit triggers take_profit', () => {
        it('returns take_profit when news is bearish, trend is not bullish, and in profit', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105, // +5% gain (in profit)
                newsSentiment: 'bearish',
                technicalTrend: 'neutral',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('뉴스 악재');
            expect(result.reason).toContain('선제 익절');
        });

        it('returns stop_loss when news is bearish and not in profit', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 99, // -1% (not in profit, but above stop loss)
                newsSentiment: 'bearish',
                technicalTrend: 'neutral',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('뉴스 악재');
            expect(result.reason).toContain('손절');
        });

        it('holds when news is bearish but trend is bullish (override)', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105, // +5% gain
                newsSentiment: 'bearish',
                technicalTrend: 'bullish',
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('NaN / invalid input protection', () => {
        it('returns stop_loss with reason when avgPrice is 0', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 0,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
            expect(result.reason).toContain('수동 확인 필요');
        });

        it('returns stop_loss with reason when avgPrice is NaN', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: NaN,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
        });

        it('returns stop_loss with reason when avgPrice is negative', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: -100,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
        });

        it('returns stop_loss with reason when avgPrice is Infinity', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: Infinity,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
        });

        it('returns hold with reason when currentPrice is 0', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 0,
            });
            expect(result.action).toBe('hold');
            expect(result.reason).toContain('유효하지 않은 현재가');
        });

        it('returns hold with reason when currentPrice is NaN', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: NaN,
            });
            expect(result.action).toBe('hold');
            expect(result.reason).toContain('유효하지 않은 현재가');
        });

        it('returns hold with reason when currentPrice is negative', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: -50,
            });
            expect(result.action).toBe('hold');
            expect(result.reason).toContain('유효하지 않은 현재가');
        });

        it('returns hold with reason when currentPrice is Infinity', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: Infinity,
            });
            expect(result.action).toBe('hold');
            expect(result.reason).toContain('유효하지 않은 현재가');
        });
    });

    describe('overallSignal triggers take_profit', () => {
        it('returns take_profit when overall AI signal is bearish and position has gain', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105, // +5% gain
                overallSignal: '종합 분석: 매도 추천. 단기 하락 예상.',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('AI 종합 분석 매도 신호');
        });

        it('holds when overall AI signal is bearish but position has no gain', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 98, // -2% loss
                overallSignal: '하락 전망. 매도 권장.',
            });
            expect(result.action).toBe('hold');
        });

        it('holds when overall AI signal is not bearish', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105, // +5% gain
                overallSignal: '매수 적기. 상승 전망.',
            });
            expect(result.action).toBe('hold');
        });

        it('holds when overallSignal is undefined', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105,
                overallSignal: undefined,
            });
            expect(result.action).toBe('hold');
        });

        it('detects bearish keywords: 약세', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 103,
                overallSignal: '약세 전환. 조정 국면.',
            });
            expect(result.action).toBe('take_profit');
        });

        it('detects bearish keywords: 하락', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 102,
                overallSignal: '하락 추세 지속 예상.',
            });
            expect(result.action).toBe('take_profit');
        });
    });

    describe('no conditions met returns hold', () => {
        it('returns hold when position is within normal range', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 102, // +2% gain — within range
            });
            expect(result.action).toBe('hold');
            expect(result.reason).toContain('유지');
        });

        it('returns hold when all optional params are undefined', () => {
            const result = evaluateExistingPosition(baseParams);
            expect(result.action).toBe('hold');
        });
    });

    describe('priority order', () => {
        it('fixed stop loss takes priority over support break (when enabled)', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 90, // -10% (exceeds both stop loss and support break)
                supportLevel: 95,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('고정 손절선');
        });

        it('support break takes priority over trend reversal', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 97, // above fixed stop loss at 95
                supportLevel: 98, // below support
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
        });

        it('trend reversal takes priority over fixed take profit (profitable = take_profit)', () => {
            // Edge case: price is +12% (above TP) and trend reversed
            // Since position is profitable, bearish trend triggers take_profit instead of stop_loss
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 112, // +12% gain (above 10% TP)
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('기술적 추세 반전');
            expect(result.reason).toContain('수익 구간 익절');
        });

        it('fixed take profit takes priority over resistance approach (when enabled)', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 111, // +11% (exceeds 10% TP)
                resistanceLevel: 112,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('고정 익절선');
        });

        it('falls through to dynamic check when fixed exit is disabled', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                fixedExitEnabled: false,
                currentPrice: 90, // -10% (would trigger fixed SL if enabled)
                supportLevel: 95, // also below support
            });
            // Should hit support break (step 2) instead of fixed SL (step 1)
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
        });
    });
});
