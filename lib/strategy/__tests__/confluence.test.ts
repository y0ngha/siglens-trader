import { describe, expect, it } from 'vitest';
import {
    CONFLUENCE_EXIT_SCORE,
    CONFLUENCE_TRIGGER_SCORE,
    isConfluenceExit,
    scoreConfluence,
} from '../confluence.js';
import type { ConfluenceSnapshot } from '../confluence.js';

function snapshot(over: Partial<ConfluenceSnapshot> = {}): ConfluenceSnapshot {
    return {
        timeframe: '1Hour',
        barTime: 1_760_000_000,
        close: 100,
        ma50: 90,
        bullish: [],
        bearish: [],
        freshBullish: [],
        freshBearish: [],
        entryTrigger: false,
        exitTrigger: false,
        ...over,
    };
}

describe('scoreConfluence', () => {
    it('스냅샷이 없으면 중립 50', () => {
        expect(scoreConfluence(null)).toBe(50);
    });

    it('방향성 신호가 하나도 없으면 중립 50', () => {
        expect(scoreConfluence(snapshot())).toBe(50);
    });

    it('진입 트리거가 서면 최소 92점', () => {
        const score = scoreConfluence(
            snapshot({
                bullish: ['cci_bullish_cross', 'parabolic_sar_flip', 'dmi_bullish_cross'],
                freshBullish: ['cci_bullish_cross'],
                entryTrigger: true,
            }),
        );
        expect(score).toBeGreaterThanOrEqual(CONFLUENCE_TRIGGER_SCORE);
    });

    it('청산 트리거가 서면 최대 8점', () => {
        const score = scoreConfluence(
            snapshot({
                close: 80,
                bearish: ['cci_bearish_cross', 'parabolic_sar_bearish_flip', 'dmi_bearish_cross'],
                freshBearish: ['cci_bearish_cross'],
                exitTrigger: true,
            }),
        );
        expect(score).toBeLessThanOrEqual(CONFLUENCE_EXIT_SCORE);
    });

    it('3종이 모여도 신규가 없으면 연속 점수만 낸다 (트리거 미성립)', () => {
        // bull 3 / bear 0 → net = 3/4 = 0.75 → 50 + 22.5 = 72.5 → 73
        const score = scoreConfluence(
            snapshot({
                bullish: ['cci_bullish_cross', 'parabolic_sar_flip', 'dmi_bullish_cross'],
                freshBullish: [],
                entryTrigger: false,
            }),
        );
        expect(score).toBe(73);
        expect(score).toBeLessThan(CONFLUENCE_TRIGGER_SCORE);
    });

    it('단일 신호는 축소 계수 때문에 극단으로 튀지 않는다', () => {
        // bull 1 / bear 0 → net = 1/2 = 0.5 → 50 + 15 = 65
        expect(scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }))).toBe(65);
    });

    it('강세와 약세가 동수면 중립 50', () => {
        expect(
            scoreConfluence(
                snapshot({ bullish: ['cci_bullish_cross'], bearish: ['cci_bearish_cross'] }),
            ),
        ).toBe(50);
    });

    it('연속 점수는 20~80 범위를 벗어나지 않는다', () => {
        const allBear = scoreConfluence(
            snapshot({ bearish: Array.from({ length: 20 }, (_, i) => `bear_${i}`) }),
        );
        expect(allBear).toBeGreaterThanOrEqual(20);
        const allBull = scoreConfluence(
            snapshot({ bullish: Array.from({ length: 20 }, (_, i) => `bull_${i}`) }),
        );
        expect(allBull).toBeLessThanOrEqual(80);
    });
});

describe('isConfluenceExit', () => {
    it('스냅샷이 없으면 false', () => {
        expect(isConfluenceExit(null)).toBe(false);
    });

    it('exitTrigger가 서면 true', () => {
        expect(isConfluenceExit(snapshot({ exitTrigger: true }))).toBe(true);
    });

    it('약세 신호가 많아도 트리거가 없으면 false', () => {
        expect(isConfluenceExit(snapshot({ bearish: ['a', 'b', 'c'], exitTrigger: false }))).toBe(
            false,
        );
    });
});
