import { describe, expect, it } from 'vitest';
import {
    CONFLUENCE_EXIT_SCORE,
    CONFLUENCE_TRIGGER_SCORE,
    confluenceFamilyWeight,
    isConfluenceExit,
    scoreConfluence,
    signalFamily,
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

    it('3계열이 모여도 신규가 없으면 연속 점수만 낸다 (트리거 미성립)', () => {
        // 계열 3(cci/psar/dmi) / 0 → net = 3/4 = 0.75 → 50 + 0.75×15 = 61.25 → 61
        const score = scoreConfluence(
            snapshot({
                bullish: ['cci_bullish_cross', 'parabolic_sar_flip', 'dmi_bullish_cross'],
                freshBullish: [],
                entryTrigger: false,
            }),
        );
        expect(score).toBe(61);
        expect(score).toBeLessThan(CONFLUENCE_TRIGGER_SCORE);
    });

    it('단일 신호가 종합을 흔들지 못한다 — 폭을 15로 좁힌 이유', () => {
        // 계열 1 / 0 → net = 1/2 → 50 + 7.5 = 57.5 → 58 (종전 폭 30에서는 65였다)
        expect(scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }))).toBe(58);
    });

    describe('지표 계열 단위 카운팅', () => {
        it('같은 지표에서 나온 시그널 여러 종은 한 표다', () => {
            // 볼린저 3종 = 1계열. 타입을 셌다면 3표였다.
            const bollingerOnly = scoreConfluence(
                snapshot({
                    bullish: [
                        'bollinger_lower_bounce',
                        'bollinger_percentb_oversold',
                        'bollinger_squeeze_bullish',
                    ],
                }),
            );
            const oneSignal = scoreConfluence(snapshot({ bullish: ['bollinger_lower_bounce'] }));
            expect(bollingerOnly).toBe(oneSignal);
        });

        it('실측 회귀 — 3종처럼 보이지만 지표는 둘이다', () => {
            // IONQ 2026-08-20: bollinger 2종 + rsi 1종. 계열은 2개다.
            const twoFamilies = scoreConfluence(
                snapshot({
                    bullish: [
                        'bollinger_lower_bounce',
                        'bollinger_percentb_oversold',
                        'rsi_oversold',
                    ],
                }),
            );
            const genuineTwo = scoreConfluence(
                snapshot({ bullish: ['bollinger_lower_bounce', 'cci_bullish_cross'] }),
            );
            expect(twoFamilies).toBe(genuineTwo);
        });

        it('서로 다른 지표는 그대로 각각 센다', () => {
            const three = scoreConfluence(
                snapshot({ bullish: ['cci_bullish_cross', 'macd_bullish_cross', 'rsi_oversold'] }),
            );
            const two = scoreConfluence(
                snapshot({ bullish: ['cci_bullish_cross', 'macd_bullish_cross'] }),
            );
            expect(three).toBeGreaterThan(two);
        });

        it('미등록 타입은 자기 자신을 계열로 삼는다 — 새 디텍터를 0표로 만들지 않는다', () => {
            expect(signalFamily('some_future_signal')).toBe('some_future_signal');
            const two = scoreConfluence(
                snapshot({ bullish: ['cci_bullish_cross', 'some_future_signal'] }),
            );
            const one = scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }));
            expect(two).toBeGreaterThan(one);
        });
    });

    describe('expected phase는 반표', () => {
        it('상태 시그널이 확정 크로스와 같은 무게를 갖지 않는다', () => {
            const expected = scoreConfluence(snapshot({ bullish: ['support_proximity_bullish'] }));
            const confirmed = scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }));
            expect(expected).toBeLessThan(confirmed);
            // 계열 0.5 / 0 → net = 0.5/1.5 = 0.333 → 50 + 5 = 55
            expect(expected).toBe(55);
        });

        it('한 계열에 confirmed와 expected가 같이 켜지면 높은 쪽만 센다', () => {
            const both = scoreConfluence(
                snapshot({ bullish: ['rsi_oversold', 'rsi_bullish_divergence'] }),
            );
            const confirmedOnly = scoreConfluence(snapshot({ bullish: ['rsi_oversold'] }));
            expect(both).toBe(confirmedOnly);
        });

        it('confluenceFamilyWeight가 소수 가중치를 그대로 돌려준다', () => {
            // cci(confirmed 1) + level(expected 0.5) = 1.5
            expect(confluenceFamilyWeight(['cci_bullish_cross', 'support_proximity_bullish'])).toBe(
                1.5,
            );
            // 볼린저 3종 = 1계열, 최고 가중치 confirmed 1
            expect(
                confluenceFamilyWeight([
                    'bollinger_squeeze_bullish',
                    'bollinger_lower_bounce',
                    'bollinger_percentb_oversold',
                ]),
            ).toBe(1);
        });

        it('가중치가 비정상이면 expected를 0표로 흡수한다', () => {
            expect(confluenceFamilyWeight(['support_proximity_bullish'], Number.NaN)).toBe(0);
            expect(confluenceFamilyWeight(['support_proximity_bullish'], -1)).toBe(0);
            // 1을 넘겨도 confirmed보다 커지지는 않는다
            expect(confluenceFamilyWeight(['support_proximity_bullish'], 5)).toBe(1);
        });
    });

    describe('스냅샷에 실린 파라미터로 채점한다', () => {
        // 이 분기가 없으면 설정 키를 아무리 바꿔도 점수가 안 움직인다.
        // 감사 지적: 여기를 갈아도 전 테스트가 통과하던 구간이었다.
        it('params.span이 연속 점수 폭을 정한다', () => {
            const base = { bullish: ['cci_bullish_cross'] };
            const narrow = scoreConfluence(
                snapshot({
                    ...base,
                    params: {
                        min: 3,
                        span: 15,
                        expectedWeight: 0.5,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            const wide = scoreConfluence(
                snapshot({
                    ...base,
                    params: {
                        min: 3,
                        span: 30,
                        expectedWeight: 0.5,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            expect(narrow).toBe(58); // 50 + 0.5×15
            expect(wide).toBe(65); // 50 + 0.5×30 — 종전 동작
        });

        it('params.expectedWeight가 expected 시그널의 표 무게를 정한다', () => {
            const withHalf = scoreConfluence(
                snapshot({
                    bullish: ['support_proximity_bullish'],
                    params: {
                        min: 3,
                        span: 15,
                        expectedWeight: 0.5,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            const withZero = scoreConfluence(
                snapshot({
                    bullish: ['support_proximity_bullish'],
                    params: {
                        min: 3,
                        span: 15,
                        expectedWeight: 0,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            const withFull = scoreConfluence(
                snapshot({
                    bullish: ['support_proximity_bullish'],
                    params: {
                        min: 3,
                        span: 15,
                        expectedWeight: 1,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            expect(withZero).toBe(50); // 표가 0이면 방향 신호가 없다 → 중립
            expect(withHalf).toBeGreaterThan(withZero);
            expect(withFull).toBeGreaterThan(withHalf);
        });

        it('params가 없는 구 스냅샷은 모듈 기본값으로 채점된다', () => {
            const legacy = scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }));
            const explicit = scoreConfluence(
                snapshot({
                    bullish: ['cci_bullish_cross'],
                    params: {
                        min: 3,
                        span: 15,
                        expectedWeight: 0.5,
                        htf: null,
                        requireVolume: false,
                    },
                }),
            );
            expect(legacy).toBe(explicit);
        });

        it('손상된 span은 기본값으로 되돌린다 — 음수는 점수의 부호를 뒤집는다', () => {
            const healthy = scoreConfluence(snapshot({ bullish: ['cci_bullish_cross'] }));
            for (const span of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
                const corrupt = scoreConfluence(
                    snapshot({
                        bullish: ['cci_bullish_cross'],
                        params: {
                            min: 3,
                            span: span as number,
                            expectedWeight: 0.5,
                            htf: null,
                            requireVolume: false,
                        },
                    }),
                );
                expect(corrupt, `span=${String(span)}`).toBe(healthy);
            }
        });
    });

    it('강세와 약세가 동수면 중립 50', () => {
        expect(
            scoreConfluence(
                snapshot({ bullish: ['cci_bullish_cross'], bearish: ['cci_bearish_cross'] }),
            ),
        ).toBe(50);
    });

    it('연속 점수는 35~65 범위를 벗어나지 않는다', () => {
        const allBear = scoreConfluence(
            snapshot({ bearish: Array.from({ length: 20 }, (_, i) => `bear_${i}`) }),
        );
        expect(allBear).toBeGreaterThanOrEqual(35);
        const allBull = scoreConfluence(
            snapshot({ bullish: Array.from({ length: 20 }, (_, i) => `bull_${i}`) }),
        );
        expect(allBull).toBeLessThanOrEqual(65);
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
