import { describe, it, expect } from 'vitest';
import {
    calculatePositionSize,
    shouldStopLoss,
    shouldTakeProfit,
    evaluateExistingPosition,
    RESISTANCE_APPROACH_BAND,
    RESISTANCE_BREAKOUT_BAND,
    SUPPORT_BREAK_BUFFER,
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
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss when loss exactly equals stopLossPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 95, // exactly -5%
            });
            expect(result.action).toBe('stop_loss');
            expect(result.hard).toBe(true);
        });

        it('returns take_profit when gain exceeds takeProfitPercent (not hard — a target, not a risk control)', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 112, // +12% gain, threshold is 10%
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('고정 익절선');
            expect(result.reason).toContain('+10%');
            expect(result.hard).toBeUndefined();
        });

        it('returns take_profit when gain exactly equals takeProfitPercent', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 110, // exactly +10%
            });
            expect(result.action).toBe('take_profit');
            expect(result.hard).toBeUndefined();
        });
    });

    describe('분석 손절가 (aiStopLoss)', () => {
        it('현재가가 분석 손절가 아래로 내려가면 stop_loss', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 94,
                aiStopLoss: 96,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('분석 손절가 이탈');
            expect(result.reason).toContain('96');
            // 분석에서 파생된 판단이므로 사이징 게이트가 얼마나 자를지 정한다.
            expect(result.hard).toBeUndefined();
        });

        it('수익 구간이면 익절로 라벨링한다 — 손절 이력·재진입 쿨다운이 잘못 걸리면 안 된다', () => {
            // $100에 산 포지션이 $145까지 오른 뒤 분석 손절선 $150을 건드린 경우.
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 145,
                aiStopLoss: 150,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('수익 구간');
        });

        it('손절가와 같으면 트리거된다 — 익절(>=)과 대칭', () => {
            // 종전 `<`는 손절선에 정확히 닿았을 때만 빠져나가, 익절보다 리스크를
            // 더 오래 들고 갔다.
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 96,
                aiStopLoss: 96,
            });
            expect(result.action).toBe('stop_loss');
        });

        it('고정 손절선이 먼저다 — 운영자가 그은 선이 분석보다 우선', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 94, // -6%, 고정 손절선(-5%)도 분석 손절가(96)도 성립
                aiStopLoss: 96,
            });
            expect(result.reason).toContain('고정 손절선');
            expect(result.hard).toBe(true);
        });

        it('지지선 이탈보다 먼저다 — 명시 손절가가 간접 신호보다 우선', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 94,
                aiStopLoss: 96,
                supportLevel: 99,
            });
            expect(result.reason).toContain('분석 손절가 이탈');
        });

        it('값이 없거나 0이면 아무것도 하지 않는다', () => {
            for (const aiStopLoss of [undefined, 0]) {
                const result = evaluateExistingPosition({
                    ...baseParams,
                    currentPrice: 94,
                    aiStopLoss,
                });
                expect(result.action).toBe('hold');
            }
        });
    });

    describe('분석 익절가 (aiTakeProfit)', () => {
        it('현재가가 분석 익절가에 닿으면 take_profit', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 110,
                aiTakeProfit: 110, // 명시 가격이므로 근사(95%/98%)를 쓰지 않는다
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('분석 익절가 도달');
            expect(result.hard).toBeUndefined();
        });

        it('익절가 아래면 아무것도 하지 않는다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 109.99,
                aiTakeProfit: 110,
            });
            expect(result.action).toBe('hold');
        });

        it('고정 익절선이 먼저다', () => {
            const result = evaluateExistingPosition({
                ...enabledParams,
                currentPrice: 112, // 고정 익절선(+10%)도 분석 익절가(105)도 성립
                aiTakeProfit: 105,
            });
            expect(result.reason).toContain('고정 익절선');
        });

        it('저항선 근접보다 먼저다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 105,
                aiTakeProfit: 105,
                resistanceLevel: 100, // 98% 근접 조건도 성립
            });
            expect(result.reason).toContain('분석 익절가 도달');
        });

        it('추세 반전이 먼저다 — 손실 방향 신호가 익절보다 위', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 112,
                aiTakeProfit: 105,
                technicalTrend: 'bearish',
            });
            expect(result.reason).toContain('기술적 추세 반전');
        });

        it('값이 없거나 0이면 아무것도 하지 않는다', () => {
            for (const aiTakeProfit of [undefined, 0]) {
                const result = evaluateExistingPosition({
                    ...baseParams,
                    currentPrice: 500,
                    aiTakeProfit,
                });
                expect(result.action).toBe('hold');
            }
        });
    });

    describe('support level break', () => {
        it('returns stop_loss when price is below support level and in loss (not hard — analysis-derived)', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 98,
                supportLevel: 99,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
            expect(result.reason).toContain('$99');
            expect(result.reason).toContain('$98');
            expect(result.hard).toBeUndefined();
        });

        it('returns take_profit when price is below support level but in profit', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 80,
                currentPrice: 98,
                supportLevel: 99,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('지지선 이탈이나 수익 구간');
            expect(result.reason).toContain('익절');
        });

        it('returns take_profit when price is below support level and at break-even', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 98,
                currentPrice: 98,
                supportLevel: 99,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('지지선 이탈이나 수익 구간');
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

    describe('technical trend reversal triggers exit', () => {
        it('returns take_profit when trend is bearish and at break-even', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 100, // break-even (gainPercent === 0)
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('기술적 추세 반전');
            expect(result.reason).toContain('수익 구간 익절');
        });

        it('returns stop_loss when trend is bearish and in loss (not hard — analysis-derived)', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 99, // -1% loss
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('기술적 추세 반전');
            expect(result.hard).toBeUndefined();
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

    describe('지지선 이탈 버퍼 — 노이즈 한 틱에 청산되지 않는다', () => {
        // 2026-08-19 PLTR 실측: 175.65 매수, 지지 175.60, 10분 뒤 175.5357(0.037% 이탈)에
        // 전량 청산 -0.57. 방향 판단이 아니라 반올림 오차로 나간 손절이었다.
        it('버퍼 안쪽의 미세 이탈은 청산하지 않는다', () => {
            const support = 100;
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100.05,
                currentPrice: support * (1 - SUPPORT_BREAK_BUFFER / 2),
                supportLevel: support,
            });
            expect(result.action).toBe('hold');
        });

        it('버퍼를 넘긴 이탈은 그대로 청산한다 — 가드지 무력화가 아니다', () => {
            const support = 100;
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 101,
                currentPrice: support * (1 - SUPPORT_BREAK_BUFFER) - 0.01,
                supportLevel: support,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
        });

        it('경계값: 정확히 버퍼선이면 아직 청산하지 않는다', () => {
            const support = 100;
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100.5,
                currentPrice: support * (1 - SUPPORT_BREAK_BUFFER),
                supportLevel: support,
            });
            expect(result.action).toBe('hold');
        });
    });

    describe('저항선 근접은 4.5(분석 익절가)의 폴백이다', () => {
        // 프로덕션 실측(2026-09-02 NVDA): 227.5272에 매수(저항 227 — **매수가보다 아래**),
        // 10분 뒤 227.45에 "저항선 근접"으로 청산. 체결되는 순간 이미 조건이 서 있었다.
        //
        // 원인은 상수화다. `keyLevels.resistance[0]`은 현재가에서 가장 가까운 저항이고
        // 매시간 다시 계산돼 가격을 따라다닌다 — 실측 706틱에서 현재가 대비 중앙 +0.19%로
        // 1Hour 실현 이동 중앙값(0.25~0.49%)보다 작다. ±2% 밴드를 씌우면 99.2%의 틱에서
        // 참이 되고, 705 표본에서 "다음 틱에 청산되지 않는" 경우가 0%였다.
        it('aiTakeProfit이 있으면 저항선 근접으로 청산하지 않는다 — 실측 회귀', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 227.5272,
                currentPrice: 227.45,
                resistanceLevel: 227,
                aiTakeProfit: 231.07,
                aiStopLoss: 222.46,
                supportLevel: 225.4,
            });
            expect(result.action).toBe('hold');
        });

        it('aiTakeProfit이 없으면 폴백이 살아나 그대로 익절한다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 227.5272,
                currentPrice: 227.45,
                resistanceLevel: 227,
                aiStopLoss: 222.46,
                supportLevel: 225.4,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('저항선 근접');
        });

        it('폴백을 막아도 분석 익절가는 그대로 발동한다 — 익절 경로가 사라지지 않는다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100,
                currentPrice: 111,
                resistanceLevel: 110,
                aiTakeProfit: 110,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('분석 익절가');
        });

        it('폴백을 막아도 손절 경로는 그대로다 — 원칙 7', () => {
            // 청산을 느슨하게 만드는 변경이므로 리스크 컨트롤이 남아 있는지 못박는다.
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100,
                currentPrice: 94,
                resistanceLevel: 94,
                aiTakeProfit: 110,
                aiStopLoss: 95,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('분석 손절가');
        });
    });

    describe('저항선 근접은 밴드다 — 돌파는 익절 사유가 아니다', () => {
        // 2026-08-13 PLTR 실측: 저항 172.33에 현재가 176.375(2.3% **위**)를 "저항선 근접"
        // 으로 청산. 매수가 178.53이라 저항선이 진입가 아래였고, 포지션이 열린 순간부터
        // 조건이 서 있었다.
        it('저항선을 크게 돌파한 가격은 익절하지 않는다', () => {
            const resistance = 100;
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 105,
                currentPrice: resistance * (1 + RESISTANCE_BREAKOUT_BAND) + 1,
                resistanceLevel: resistance,
            });
            expect(result.action).toBe('hold');
        });

        it('저항선이 매수가보다 아래여도 즉시 익절하지 않는다 — 실측 회귀', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 178.53,
                currentPrice: 176.375,
                resistanceLevel: 172.33,
            });
            expect(result.action).not.toBe('take_profit');
        });

        it('밴드 안(저항선 살짝 위)은 그대로 익절한다', () => {
            const resistance = 100;
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 95,
                currentPrice: resistance * (1 + RESISTANCE_BREAKOUT_BAND / 2),
                resistanceLevel: resistance,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('저항선 근접');
        });

        it('목표가는 상한을 두지 않는다 — 도달과 돌파가 같은 뜻이다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100,
                currentPrice: 500,
                targetPrice: 120,
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('목표가 근접');
        });

        it('밴드 하한은 종전 2% 근접 그대로', () => {
            expect(RESISTANCE_APPROACH_BAND).toBe(0.02);
        });
    });

    describe('익절 트리거가 손실 구간에서 서면 structural이다', () => {
        // 익절 레벨은 전부 **우리 매수가와 무관한 절대 가격**이다. 분석이 그린 그림보다
        // 비싸게 산 포지션은 미실현 손실 상태에서 그 선에 닿는다(실측 2026-08-13: 178.53에
        // 사고 레벨은 ~174 기준). 그때 게이트에 `take_profit` 트리거가 그대로 가면 프롬프트가
        // "목표 달성형"으로 읽고 일부만 덜어낸 뒤 나머지를 태운다 — 정반대 사이징이다.
        it('분석 익절가: 손실 구간이면 structural', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 178.53,
                currentPrice: 175,
                aiTakeProfit: 174,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBe(true);
        });

        it('분석 익절가: 수익 구간이면 structural이 아니다 — 진짜 목표 달성이다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 100,
                currentPrice: 120,
                aiTakeProfit: 115,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBeUndefined();
        });

        it('저항선 근접: 손실 구간이면 structural', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 110,
                currentPrice: 100,
                resistanceLevel: 100,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBe(true);
        });

        it('저항선 근접: 수익 구간이면 structural이 아니다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 90,
                currentPrice: 100,
                resistanceLevel: 100,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBeUndefined();
        });

        it('목표가 근접: 손실 구간이면 structural', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 110,
                currentPrice: 100,
                targetPrice: 100,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBe(true);
        });

        it('목표가 근접: 수익 구간이면 structural이 아니다', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 90,
                currentPrice: 100,
                targetPrice: 100,
            });
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBeUndefined();
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

        it('returns take_profit when news is bearish and at break-even', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 100, // break-even (gainPercent === 0)
                newsSentiment: 'bearish',
                technicalTrend: 'neutral',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('뉴스 악재');
            expect(result.reason).toContain('선제 익절');
        });

        it('returns stop_loss when news is bearish and not in profit (not hard — analysis-derived)', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 99, // -1% (not in profit, but above stop loss)
                newsSentiment: 'bearish',
                technicalTrend: 'neutral',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('뉴스 악재');
            expect(result.reason).toContain('손절');
            expect(result.hard).toBeUndefined();
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
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when avgPrice is NaN', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: NaN,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when avgPrice is negative', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: -100,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when avgPrice is Infinity', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: Infinity,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 매수가');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when currentPrice is 0', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 0,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 현재가');
            expect(result.reason).toContain('수동 확인 필요');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when currentPrice is NaN', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: NaN,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 현재가');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when currentPrice is negative', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: -50,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 현재가');
            expect(result.hard).toBe(true);
        });

        it('returns stop_loss with reason when currentPrice is Infinity', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: Infinity,
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('유효하지 않은 현재가');
            expect(result.hard).toBe(true);
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
            expect(result.hard).toBe(true);
        });

        it('support break takes priority over trend reversal (loss zone)', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                currentPrice: 97, // above fixed stop loss at 95, in loss zone
                supportLevel: 98, // below support
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('stop_loss');
            expect(result.reason).toContain('지지선 이탈');
        });

        it('support break in profit zone returns take_profit before trend check', () => {
            const result = evaluateExistingPosition({
                ...baseParams,
                avgPrice: 80, // bought at 80
                currentPrice: 97, // in profit zone
                supportLevel: 98, // below support
                technicalTrend: 'bearish',
            });
            expect(result.action).toBe('take_profit');
            expect(result.reason).toContain('지지선 이탈이나 수익 구간');
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

describe('하락 컨플루언스 청산', () => {
    const base = { avgPrice: 100, stopLossPercent: 5, takeProfitPercent: 10 };

    it('수익 구간이면 익절로 나간다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 104,
            confluenceExit: true,
        });
        expect(result.action).toBe('take_profit');
        expect(result.reason).toContain('컨플루언스');
        expect(result.hard).toBeUndefined();
    });

    it('손실 구간이면 손절로 나간다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 98,
            confluenceExit: true,
        });
        expect(result.action).toBe('stop_loss');
        expect(result.reason).toContain('컨플루언스');
        expect(result.hard).toBeUndefined();
    });

    it('고정 손절선이 컨플루언스보다 우선한다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 94,
            fixedExitEnabled: true,
            confluenceExit: true,
        });
        expect(result.reason).toContain('고정 손절선');
        expect(result.hard).toBe(true);
    });

    it('지지선 이탈이 컨플루언스보다 우선한다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 95,
            supportLevel: 97,
            confluenceExit: true,
        });
        expect(result.reason).toContain('지지선 이탈');
    });

    it('기술적 추세 반전이 컨플루언스보다 우선한다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 95,
            technicalTrend: 'bearish',
            confluenceExit: true,
        });
        expect(result.reason).toContain('기술적 추세 반전');
    });

    it('confluenceExit이 false면 기존 동작과 동일하다', () => {
        const result = evaluateExistingPosition({
            ...base,
            currentPrice: 101,
            confluenceExit: false,
        });
        expect(result.action).toBe('hold');
    });
});

describe('구조 훼손 표시 (structural)', () => {
    const base: EvaluatePositionParams = {
        avgPrice: 100,
        currentPrice: 100,
        stopLossPercent: 5,
        takeProfitPercent: 10,
    };

    it('지지선 이탈·추세 반전·컨플루언스·분석 손절가는 수익 구간에서도 structural이다', () => {
        // 라벨은 `take_profit`이지만 목표 달성이 아니다. 이 표시가 없으면 사이징 게이트가
        // "익절이니 일부만 덜어내고 나머지는 태운다"로 읽는다.
        const cases: EvaluatePositionParams[] = [
            { ...base, currentPrice: 120, supportLevel: 130 },
            { ...base, currentPrice: 120, technicalTrend: 'bearish' },
            { ...base, currentPrice: 120, confluenceExit: true },
            { ...base, currentPrice: 120, aiStopLoss: 130 },
            { ...base, currentPrice: 120, newsSentiment: 'bearish' },
        ];
        for (const params of cases) {
            const result = evaluateExistingPosition(params);
            expect(result.action).toBe('take_profit');
            expect(result.structural).toBe(true);
        }
    });

    it('목표 달성형 익절에는 structural이 붙지 않는다', () => {
        expect(
            evaluateExistingPosition({ ...base, currentPrice: 120, aiTakeProfit: 115 }).structural,
        ).toBeUndefined();
        expect(
            evaluateExistingPosition({ ...base, currentPrice: 120, resistanceLevel: 121 })
                .structural,
        ).toBeUndefined();
    });
});
