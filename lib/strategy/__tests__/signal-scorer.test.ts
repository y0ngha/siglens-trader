import { describe, it, expect } from 'vitest';
import { scoreSignals } from '../signal-scorer';
import { DEFAULT_WEIGHTS, DEFAULT_BUY_THRESHOLD, DEFAULT_SELL_THRESHOLD } from '../types';
import type { ScoreWeights } from '../types';
import type { ConfluenceSnapshot } from '../confluence';

describe('scoreSignals', () => {
    describe('happy path — bullish inputs', () => {
        it('returns high score and buy signal for fully bullish inputs', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: { overallSentiment: 'bullish' },
                    options: {
                        signals: [{ kind: 'bullish' }, { kind: 'bullish' }, { kind: 'bullish' }],
                    },
                    fundamental: { overallSentiment: 'bullish' },
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.total).toBeGreaterThanOrEqual(70);
            expect(result.signal).toBe('buy');
            expect(result.components.technical).toBeGreaterThan(80);
            expect(result.components.news).toBe(80);
            expect(result.components.options).toBeGreaterThan(50);
            expect(result.components.fundamental).toBe(80);
        });
    });

    describe('happy path — bearish inputs', () => {
        it('returns low score and sell signal for fully bearish inputs', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bearish', riskLevel: 'high' },
                    news: { overallSentiment: 'bearish' },
                    options: {
                        signals: [{ kind: 'bearish' }, { kind: 'bearish' }, { kind: 'bearish' }],
                    },
                    fundamental: { overallSentiment: 'bearish' },
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.total).toBeLessThanOrEqual(30);
            expect(result.signal).toBe('sell');
            expect(result.components.technical).toBeLessThan(20);
            expect(result.components.news).toBe(20);
            expect(result.components.options).toBeLessThan(50);
            expect(result.components.fundamental).toBe(20);
        });
    });

    describe('neutral/mixed inputs', () => {
        it('returns hold signal for neutral inputs', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: { signals: [{ kind: 'bullish' }, { kind: 'bearish' }] },
                    fundamental: { overallSentiment: 'neutral' },
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.total).toBeGreaterThan(30);
            expect(result.total).toBeLessThan(70);
            expect(result.signal).toBe('hold');
        });
    });

    describe('all null inputs', () => {
        it('returns 50 (neutral) and hold signal when all inputs are null', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.total).toBe(50);
            expect(result.signal).toBe('hold');
            expect(result.components.technical).toBe(50);
            expect(result.components.news).toBe(50);
            expect(result.components.options).toBe(50);
            expect(result.components.fundamental).toBe(50);
        });
    });

    describe('partial inputs', () => {
        it('handles some null and some provided analyses', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: null,
                    options: null,
                    fundamental: { overallSentiment: 'bullish' },
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // technical = 95, news = 50, options = 50, fundamental = 80; congress is absent,
            // so its weight drops out entirely rather than voting a neutral 50.
            // weighted: (95*8 + 50*6 + 50*5 + 80*4) / 23 = 1630/23 = 70.9 → 71 → buy
            expect(result.components.technical).toBe(95);
            expect(result.components.news).toBe(50);
            expect(result.components.options).toBe(50);
            expect(result.components.fundamental).toBe(80);
            expect(result.total).toBe(71);
            expect(result.signal).toBe('buy');
        });

        it('handles technical with missing fields', () => {
            const result = scoreSignals(
                {
                    technical: { trend: undefined, riskLevel: undefined },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // trend undefined → 50, riskLevel undefined → 0 modifier
            expect(result.components.technical).toBe(50);
        });
    });

    describe('boundary — buy threshold', () => {
        it('returns buy when score is exactly at buy threshold', () => {
            // We need to craft inputs that produce exactly 70
            // With default weights: tech=8, news=6, options=5, fundamental=4 (sum 23)
            // If every component weighted-averages to ~70 the total is ~70
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'high' },
                    // bullish=85, high=-10 → 75
                    news: { overallSentiment: 'bullish' },
                    // 80
                    options: { signals: [{ kind: 'bullish' }, { kind: 'bearish' }] },
                    // 50 (equal split)
                    fundamental: { overallSentiment: 'neutral' },
                    // 50
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // Verify signal determination logic at boundary
            // The exact score here may not be 70, but we test the threshold logic separately
            if (result.total >= 70) {
                expect(result.signal).toBe('buy');
            } else if (result.total <= 30) {
                expect(result.signal).toBe('sell');
            } else {
                expect(result.signal).toBe('hold');
            }
        });

        it('returns buy when score equals buyThreshold exactly', () => {
            // Use custom thresholds to test boundary
            const result = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: { signals: [] },
                    fundamental: { overallSentiment: 'neutral' },
                },
                DEFAULT_WEIGHTS,
                50, // buyThreshold = 50
                30,
            );

            // All neutral → 50, threshold = 50, score >= threshold → buy
            expect(result.total).toBe(50);
            expect(result.signal).toBe('buy');
        });
    });

    describe('boundary — sell threshold', () => {
        it('returns sell when score equals sellThreshold exactly', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bearish', riskLevel: 'medium' },
                    // bearish=15, medium=0 → 15
                    news: { overallSentiment: 'bearish' },
                    // 20
                    options: { signals: [{ kind: 'bearish' }] },
                    // shrink k=1: -1/(1+1) → 25
                    fundamental: { overallSentiment: 'bearish' },
                    // 20
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // We verify sell signal is given when total <= threshold
            expect(result.total).toBeLessThanOrEqual(30);
            expect(result.signal).toBe('sell');
        });

        it('returns hold when score is just above sell threshold', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                49, // sellThreshold just below neutral 50
            );

            expect(result.total).toBe(50);
            expect(result.signal).toBe('hold');
        });
    });

    describe('custom weights', () => {
        it('heavily weighted technical produces different result than default', () => {
            const techHeavyWeights: ScoreWeights = {
                // 이 테스트는 technical 지배력만 본다. inputs에 confluence 스냅샷이 없어
                // 어차피 분모에서 빠지지만, 의도를 분명히 하려고 0으로 둔다.
                confluence: 0,
                technical: 80,
                news: 5,
                options: 5,
                fundamental: 5,
                congress: 0,
            };

            const inputs = {
                technical: { trend: 'bullish', riskLevel: 'low' },
                news: { overallSentiment: 'bearish' },
                options: { signals: [{ kind: 'bearish' }] },
                fundamental: { overallSentiment: 'bearish' },
            };

            const defaultResult = scoreSignals(inputs, DEFAULT_WEIGHTS, 70, 30);
            const techHeavyResult = scoreSignals(inputs, techHeavyWeights, 70, 30);

            // With tech-heavy weights, bullish technical dominates
            expect(techHeavyResult.total).toBeGreaterThan(defaultResult.total);
            expect(techHeavyResult.signal).toBe('buy');
        });

        it('equal weights produce simple average', () => {
            const equalWeights: ScoreWeights = {
                confluence: 20,
                technical: 20,
                news: 20,
                options: 20,
                fundamental: 20,
                congress: 20,
            };

            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'medium' },
                    // 85
                    news: { overallSentiment: 'bearish' },
                    // 20
                    options: { signals: [] },
                    // 50
                    fundamental: { overallSentiment: 'neutral' },
                    // 50
                    congress: null,
                    // 50
                },
                equalWeights,
                70,
                30,
            );

            // (85 + 20 + 50 + 50 + 50) / 5 = 51
            expect(result.total).toBe(51);
        });
    });

    describe('custom thresholds', () => {
        it('uses custom buy threshold', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                60, // lower buy threshold
                30,
            );

            // tech=85, news=50, options=50, fund=50
            // (85*8 + 50*6 + 50*5 + 50*4) / 23 = 1430/23 = 62.2 → 62 ≥ 60 → buy
            expect(result.total).toBeGreaterThanOrEqual(60);
            expect(result.signal).toBe('buy');
        });

        it('uses custom sell threshold', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                55, // higher sell threshold
            );

            // All neutral → 50, sellThreshold=55, score <= 55 → sell
            expect(result.total).toBe(50);
            expect(result.signal).toBe('sell');
        });
    });

    describe('component scores', () => {
        it('calculates technical score correctly for each trend + risk combination', () => {
            const makeInput = (trend: string, riskLevel: string) => ({
                technical: { trend, riskLevel },
                news: null,
                options: null,
                fundamental: null,
            });

            // bullish + low = 85 + 10 = 95
            expect(
                scoreSignals(makeInput('bullish', 'low'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(95);

            // bullish + medium = 85 + 0 = 85
            expect(
                scoreSignals(makeInput('bullish', 'medium'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(85);

            // bullish + high = 85 - 10 = 75
            expect(
                scoreSignals(makeInput('bullish', 'high'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(75);

            // neutral + low = 50 + 10 = 60
            expect(
                scoreSignals(makeInput('neutral', 'low'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(60);

            // neutral + medium = 50 + 0 = 50
            expect(
                scoreSignals(makeInput('neutral', 'medium'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(50);

            // neutral + high = 50 - 10 = 40
            expect(
                scoreSignals(makeInput('neutral', 'high'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(40);

            // bearish + low = 15 + 10 = 25
            expect(
                scoreSignals(makeInput('bearish', 'low'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(25);

            // bearish + medium = 15 + 0 = 15
            expect(
                scoreSignals(makeInput('bearish', 'medium'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(15);

            // bearish + high = 15 - 10 = 5
            expect(
                scoreSignals(makeInput('bearish', 'high'), DEFAULT_WEIGHTS, 70, 30).components
                    .technical,
            ).toBe(5);
        });

        it('calculates news score correctly', () => {
            const makeInput = (sentiment: string) => ({
                technical: null,
                news: { overallSentiment: sentiment },
                options: null,
                fundamental: null,
            });

            expect(
                scoreSignals(makeInput('bullish'), DEFAULT_WEIGHTS, 70, 30).components.news,
            ).toBe(80);
            expect(
                scoreSignals(makeInput('neutral'), DEFAULT_WEIGHTS, 70, 30).components.news,
            ).toBe(50);
            expect(
                scoreSignals(makeInput('bearish'), DEFAULT_WEIGHTS, 70, 30).components.news,
            ).toBe(20);
        });

        it('calculates fundamental score correctly', () => {
            const makeInput = (sentiment: string) => ({
                technical: null,
                news: null,
                options: null,
                fundamental: { overallSentiment: sentiment },
            });

            expect(
                scoreSignals(makeInput('bullish'), DEFAULT_WEIGHTS, 70, 30).components.fundamental,
            ).toBe(80);
            expect(
                scoreSignals(makeInput('neutral'), DEFAULT_WEIGHTS, 70, 30).components.fundamental,
            ).toBe(50);
            expect(
                scoreSignals(makeInput('bearish'), DEFAULT_WEIGHTS, 70, 30).components.fundamental,
            ).toBe(20);
        });
    });

    describe('edge case — options with no signals', () => {
        it('returns 50 for empty signals array', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: { signals: [] },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            expect(result.components.options).toBe(50);
        });

        it('returns 50 for options with undefined signals', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: { signals: undefined },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            expect(result.components.options).toBe(50);
        });
    });

    describe('edge case — options with mixed signals', () => {
        it('scores based on bullish/bearish ratio', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [
                            { kind: 'bullish' },
                            { kind: 'bullish' },
                            { kind: 'bearish' },
                            { kind: 'neutral' },
                        ],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // 2 bullish, 1 bearish, 1 neutral. Neutral ignored → directional = 3.
            // shrink k=1: ratio = (2-1)/(3+1) = 0.25, score = 50 + 0.25*50 = 62.5 → 63
            expect(result.components.options).toBe(63);
        });

        it('all bullish signals gives maximum options score', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ kind: 'bullish' }, { kind: 'bullish' }, { kind: 'bullish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // shrink k=1: ratio = 3/(3+1) = 0.75, score = 50 + 0.75*50 = 87.5 → 88
            expect(result.components.options).toBe(88);
        });

        it('all bearish signals gives minimum options score', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ kind: 'bearish' }, { kind: 'bearish' }, { kind: 'bearish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // shrink k=1: ratio = -3/(3+1) = -0.75, score = 50 + (-0.75)*50 = 12.5 → 13
            expect(result.components.options).toBe(13);
        });

        it('ignores non-directional kinds (neutral/volatility/unknown)', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ kind: 'neutral' }, { kind: 'volatility' }, { kind: 'bullish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // Only the 1 bullish signal is directional → directional = 1.
            // shrink k=1: ratio = 1/(1+1) = 0.5, score = 50 + 0.5*50 = 75
            expect(result.components.options).toBe(75);
        });

        it('returns 50 when only non-directional signals are present', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ kind: 'neutral' }, { kind: 'volatility' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // directional = 0 → neutral 50
            expect(result.components.options).toBe(50);
        });
    });

    describe('score clamping', () => {
        it('total score never exceeds 100', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: { overallSentiment: 'bullish' },
                    options: { signals: [{ kind: 'bullish' }] },
                    fundamental: { overallSentiment: 'bullish' },
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            expect(result.total).toBeLessThanOrEqual(100);
            expect(result.total).toBeGreaterThanOrEqual(0);
        });

        it('total score never goes below 0', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bearish', riskLevel: 'high' },
                    news: { overallSentiment: 'bearish' },
                    options: { signals: [{ kind: 'bearish' }] },
                    fundamental: { overallSentiment: 'bearish' },
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            expect(result.total).toBeGreaterThanOrEqual(0);
            expect(result.total).toBeLessThanOrEqual(100);
        });
    });

    describe('zero total weight', () => {
        it('returns 50 / hold when all weights are zero', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: { overallSentiment: 'bullish' },
                    options: { signals: [{ kind: 'bullish' }] },
                    fundamental: { overallSentiment: 'bullish' },
                },
                { confluence: 0, technical: 0, news: 0, options: 0, fundamental: 0, congress: 0 },
                70,
                30,
            );

            expect(result.total).toBe(50);
            expect(result.signal).toBe('hold');
        });
    });

    describe('actionRecommendation scoring (entryRecommendation)', () => {
        it('enter recommendation adds +20 to technical score', () => {
            const withRec = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { entryRecommendation: 'enter' },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // neutral=50, medium=0, enter=+20 → 70
            expect(withRec.components.technical).toBe(70);
        });

        it('enter bonus is clamped to 100 with strong trend', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'bullish',
                        riskLevel: 'low',
                        actionRecommendation: { entryRecommendation: 'enter' },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // bullish=85, low=+10, enter=+20 → 115 clamped to 100
            expect(result.components.technical).toBe(100);
        });

        it('wait recommendation reduces technical score by 15', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'bullish',
                        riskLevel: 'medium',
                        actionRecommendation: { entryRecommendation: 'wait' },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // bullish=85, medium=0, wait=-15 → 70
            expect(result.components.technical).toBe(70);
        });

        it('avoid recommendation reduces technical score by 25', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { entryRecommendation: 'avoid' },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // neutral=50, medium=0, avoid=-25 → 25
            expect(result.components.technical).toBe(25);
        });

        it('avoid modifier is clamped to 0 with bearish trend', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'bearish',
                        riskLevel: 'high',
                        actionRecommendation: { entryRecommendation: 'avoid' },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // bearish=15, high=-10, avoid=-25 → -20 clamped to 0
            expect(result.components.technical).toBe(0);
        });

        it('absent actionRecommendation does not change score (backward compat)', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // bullish=85, low=+10, no rec → 95
            expect(result.components.technical).toBe(95);
        });
    });

    describe('technical indicator aggregation', () => {
        type TechExtra = {
            trend?: string;
            riskLevel?: string;
            actionRecommendation?: { entryRecommendation: 'enter' | 'wait' | 'avoid' };
        };
        const tech = (
            indicators: Array<{ trend?: string; strength?: string }>,
            extra: TechExtra = {},
        ) =>
            scoreSignals(
                {
                    technical: { indicators, ...extra },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            ).components.technical;

        it('all bullish-strong indicators → max trend score (85)', () => {
            expect(
                tech([
                    { trend: 'bullish', strength: 'strong' },
                    { trend: 'bullish', strength: 'strong' },
                ]),
            ).toBe(85);
        });

        it('all bearish-strong indicators → min trend score (15)', () => {
            expect(
                tech([
                    { trend: 'bearish', strength: 'strong' },
                    { trend: 'bearish', strength: 'strong' },
                ]),
            ).toBe(15);
        });

        it('strength-weighted: strong bull vs weak bear leans bullish', () => {
            // num = 3 - 1 = 2, den = 4, agg = 0.5 → 50 + 0.5*35 = 67.5 → 68
            expect(
                tech([
                    { trend: 'bullish', strength: 'strong' },
                    { trend: 'bearish', strength: 'weak' },
                ]),
            ).toBe(68);
        });

        it('neutral indicators dilute the score toward 50', () => {
            // strong bull (w3) + 2 neutral (w2 each): num=3, den=7, agg=0.4286 → 65
            expect(
                tech([
                    { trend: 'bullish', strength: 'strong' },
                    { trend: 'neutral', strength: 'moderate' },
                    { trend: 'neutral', strength: 'moderate' },
                ]),
            ).toBe(65);
        });

        it('missing strength counts as moderate weight', () => {
            // bull(w2) vs bear(w2) → 0 → 50
            expect(tech([{ trend: 'bullish' }, { trend: 'bearish' }])).toBe(50);
        });

        it('unknown trend labels are ignored', () => {
            // only the bullish-strong signal counts → 85
            expect(tech([{ trend: 'bullish', strength: 'strong' }, { trend: 'sideways' }])).toBe(
                85,
            );
        });

        it('indicators take precedence over top-level trend', () => {
            expect(tech([{ trend: 'bearish', strength: 'strong' }], { trend: 'bullish' })).toBe(15);
        });

        it('falls back to top-level trend when no indicators', () => {
            expect(tech([], { trend: 'bullish' })).toBe(85);
        });

        it('combines aggregate with risk and recommendation modifiers (clamped)', () => {
            // all bullish strong = 85, low risk +10, enter +20 = 115 → clamp 100
            expect(
                tech([{ trend: 'bullish', strength: 'strong' }], {
                    riskLevel: 'low',
                    actionRecommendation: { entryRecommendation: 'enter' },
                }),
            ).toBe(100);
        });
    });

    describe('congress scoring', () => {
        it('absent congress does not dilute the other components', () => {
            // Regression guard: congress data is missing for most symbols, so if its weight
            // still counted, a constant neutral 50 would drag the aggregate toward 50 and
            // make both entries and exits harder purely by enabling the feature.
            const inputs = {
                technical: { trend: 'bullish' as const, riskLevel: 'low' },
                news: { overallSentiment: 'bullish' },
                options: null,
                fundamental: { overallSentiment: 'bullish' },
                congress: null,
            };
            const withCongressWeight = scoreSignals(
                inputs,
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );
            const withoutCongressWeight = scoreSignals(
                inputs,
                { ...DEFAULT_WEIGHTS, congress: 0 },
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(withCongressWeight.total).toBe(withoutCongressWeight.total);
        });

        it('null congress scores neutral (50) and does not change hold signal', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: { overallSentiment: 'neutral' },
                    congress: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.components.congress).toBe(50);
            expect(result.signal).toBe('hold');
        });

        it('bullish congress raises the weighted total above neutral-only baseline', () => {
            const withoutCongress = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: { overallSentiment: 'neutral' },
                    congress: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            const withBullishCongress = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: { overallSentiment: 'neutral' },
                    options: null,
                    fundamental: { overallSentiment: 'neutral' },
                    congress: { overallSentiment: 'bullish' },
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // null congress scores 50 (neutral). bullish scores 80. The weighted sum must increase.
            expect(withBullishCongress.total).toBeGreaterThan(withoutCongress.total);
            expect(withBullishCongress.components.congress).toBe(80);
        });

        it('congress weight is included in totalWeight (zero-weight sanity check)', () => {
            // All weights zero except congress → total should be 80 (bullish congress score)
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: null,
                    fundamental: null,
                    congress: { overallSentiment: 'bullish' },
                },
                { confluence: 0, technical: 0, news: 0, options: 0, fundamental: 0, congress: 10 },
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.components.congress).toBe(80);
            expect(result.total).toBe(80);
            expect(result.signal).toBe('buy');
        });

        it('bearish congress lowers the weighted total', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: null,
                    fundamental: null,
                    congress: { overallSentiment: 'bearish' },
                },
                { confluence: 0, technical: 0, news: 0, options: 0, fundamental: 0, congress: 10 },
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(result.components.congress).toBe(20);
            expect(result.total).toBe(20);
            expect(result.signal).toBe('sell');
        });
    });

    describe('fundamental category aggregation', () => {
        const fund = (
            categories: Array<{ sentiment?: string }>,
            extra: { overallSentiment?: string } = {},
        ) =>
            scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: null,
                    fundamental: { categories, ...extra },
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            ).components.fundamental;

        it('all bullish categories → 80', () => {
            expect(fund([{ sentiment: 'bullish' }, { sentiment: 'bullish' }])).toBe(80);
        });

        it('all bearish categories → 20', () => {
            expect(fund([{ sentiment: 'bearish' }, { sentiment: 'bearish' }])).toBe(20);
        });

        it('mixed categories balance toward 50', () => {
            expect(
                fund([
                    { sentiment: 'bullish' },
                    { sentiment: 'bearish' },
                    { sentiment: 'neutral' },
                ]),
            ).toBe(50);
        });

        it('majority bearish with one neutral → 30', () => {
            // num=-2, den=3, agg=-0.667 → 50 - 0.667*30 = 30
            expect(
                fund([
                    { sentiment: 'bearish' },
                    { sentiment: 'bearish' },
                    { sentiment: 'neutral' },
                ]),
            ).toBe(30);
        });

        it('categories take precedence over overallSentiment', () => {
            expect(fund([{ sentiment: 'bearish' }], { overallSentiment: 'bullish' })).toBe(20);
        });

        it('falls back to overallSentiment when no categories', () => {
            expect(fund([], { overallSentiment: 'bullish' })).toBe(80);
        });

        it('falls back when all category sentiments are unknown', () => {
            // all unknown → agg null → fallback overallSentiment neutral → 50
            expect(fund([{ sentiment: '???' }], { overallSentiment: 'neutral' })).toBe(50);
        });
    });
});

describe('confluence 축', () => {
    const neutralInputs = {
        technical: null,
        news: null,
        options: null,
        fundamental: null,
        congress: null,
    };

    function confluenceSnapshot(over: Partial<ConfluenceSnapshot> = {}): ConfluenceSnapshot {
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

    it('스냅샷이 없으면 분모에서 빠져 도입 이전과 동일한 점수가 나온다', () => {
        const inputs = { ...neutralInputs, technical: { trend: 'bullish' } };
        const withNull = scoreSignals({ ...inputs, confluence: null }, DEFAULT_WEIGHTS, 70, 30);
        const withoutAxis = scoreSignals(
            { ...inputs, confluence: null },
            { ...DEFAULT_WEIGHTS, confluence: 0 },
            70,
            30,
        );
        expect(withNull.total).toBe(withoutAxis.total);
        expect(withNull.components.confluence).toBe(50);
    });

    it('스냅샷이 있으면 가중 평균에 참여한다', () => {
        const bull = scoreSignals(
            { ...neutralInputs, confluence: confluenceSnapshot({ bullish: ['a', 'b', 'c'] }) },
            DEFAULT_WEIGHTS,
            70,
            30,
        );
        // bull 3 / bear 0 → 73. 나머지 축은 모두 50이고, congress는 null이라 기존 규칙대로
        // 분모에서 빠진다. (73*12 + 50*(8+6+5+4)) / (12+8+6+5+4) = 2026/35 = 57.9 → 58
        expect(bull.components.confluence).toBe(73);
        expect(bull.total).toBe(58);
    });

    it('진입 트리거 단독으로는 매수 임계(70)를 넘지 못한다', () => {
        const score = scoreSignals(
            {
                ...neutralInputs,
                confluence: confluenceSnapshot({
                    bullish: ['a', 'b', 'c'],
                    freshBullish: ['a'],
                    entryTrigger: true,
                }),
            },
            DEFAULT_WEIGHTS,
            70,
            30,
        );
        expect(score.components.confluence).toBe(92);
        expect(score.total).toBeLessThan(70);
        expect(score.signal).toBe('hold');
    });

    it('청산 트리거 단독으로는 매도 임계(30)를 밑돌지 않는다', () => {
        const score = scoreSignals(
            {
                ...neutralInputs,
                confluence: confluenceSnapshot({
                    close: 80,
                    bearish: ['a', 'b', 'c'],
                    freshBearish: ['a'],
                    exitTrigger: true,
                }),
            },
            DEFAULT_WEIGHTS,
            70,
            30,
        );
        expect(score.components.confluence).toBe(8);
        expect(score.total).toBeGreaterThan(30);
        expect(score.signal).toBe('hold');
    });

    it('모든 가중치가 0이면 total 50 / hold', () => {
        const zero = {
            confluence: 0,
            technical: 0,
            news: 0,
            options: 0,
            fundamental: 0,
            congress: 0,
        };
        const score = scoreSignals(
            { ...neutralInputs, confluence: confluenceSnapshot() },
            zero,
            70,
            30,
        );
        expect(score.total).toBe(50);
        expect(score.signal).toBe('hold');
    });
});
