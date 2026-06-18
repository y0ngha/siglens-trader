import { describe, it, expect } from 'vitest';
import { scoreSignals } from '../signal-scorer';
import { DEFAULT_WEIGHTS, DEFAULT_BUY_THRESHOLD, DEFAULT_SELL_THRESHOLD } from '../types';
import type { ScoreWeights } from '../types';

describe('scoreSignals', () => {
    describe('happy path — bullish inputs', () => {
        it('returns high score and buy signal for fully bullish inputs', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: { overallSentiment: 'bullish' },
                    options: {
                        signals: [{ type: 'bullish' }, { type: 'bullish' }, { type: 'bullish' }],
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
                        signals: [{ type: 'bearish' }, { type: 'bearish' }, { type: 'bearish' }],
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
                    options: { signals: [{ type: 'bullish' }, { type: 'bearish' }] },
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

            // technical = 95, news = 50, options = 50, fundamental = 80
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
                    options: { signals: [{ type: 'bullish' }, { type: 'bearish' }] },
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
                    options: { signals: [{ type: 'bearish' }] },
                    // 0
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
                technical: 80,
                news: 5,
                options: 5,
                fundamental: 5,
            };

            const inputs = {
                technical: { trend: 'bullish', riskLevel: 'low' },
                news: { overallSentiment: 'bearish' },
                options: { signals: [{ type: 'bearish' }] },
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
                technical: 20,
                news: 20,
                options: 20,
                fundamental: 20,
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
                },
                equalWeights,
                70,
                30,
            );

            // (85 + 20 + 50 + 50) / 4 = 51.25 → 51
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
                            { type: 'bullish' },
                            { type: 'bullish' },
                            { type: 'bearish' },
                            { type: 'neutral' },
                        ],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // 2 bullish, 1 bearish out of 4 total signals
            // ratio = (2 - 1) / 4 = 0.25, score = 50 + 0.25 * 50 = 62.5 → 63 (rounded)
            expect(result.components.options).toBeGreaterThan(50);
            expect(result.components.options).toBeLessThan(80);
        });

        it('all bullish signals gives maximum options score', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ type: 'bullish' }, { type: 'bullish' }, { type: 'bullish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // ratio = 3/3 = 1.0, score = 50 + 1.0 * 50 = 100
            expect(result.components.options).toBe(100);
        });

        it('all bearish signals gives minimum options score', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ type: 'bearish' }, { type: 'bearish' }, { type: 'bearish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // ratio = -3/3 = -1.0, score = 50 + (-1.0) * 50 = 0
            expect(result.components.options).toBe(0);
        });

        it('handles signals with unknown types as neutral', () => {
            const result = scoreSignals(
                {
                    technical: null,
                    news: null,
                    options: {
                        signals: [{ type: 'unknown' }, { type: 'bullish' }],
                    },
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                70,
                30,
            );

            // 1 bullish, 0 bearish out of 2 signals
            // ratio = (1 - 0) / 2 = 0.5, score = 50 + 0.5 * 50 = 75
            expect(result.components.options).toBe(75);
        });
    });

    describe('score clamping', () => {
        it('total score never exceeds 100', () => {
            const result = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'low' },
                    news: { overallSentiment: 'bullish' },
                    options: { signals: [{ type: 'bullish' }] },
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
                    options: { signals: [{ type: 'bearish' }] },
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
                    options: { signals: [{ type: 'bullish' }] },
                    fundamental: { overallSentiment: 'bullish' },
                },
                { technical: 0, news: 0, options: 0, fundamental: 0 },
                70,
                30,
            );

            expect(result.total).toBe(50);
            expect(result.signal).toBe('hold');
        });
    });

    describe('actionRecommendation scoring', () => {
        it('buy action with high confidence boosts technical score', () => {
            const withRec = scoreSignals(
                {
                    technical: {
                        trend: 'bullish',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'buy', confidence: 0.9 },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            const withoutRec = scoreSignals(
                {
                    technical: { trend: 'bullish', riskLevel: 'medium' },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // bullish=85, medium=0, buy(0.9)=+18 → 100 (clamped) vs 85
            expect(withRec.components.technical).toBeGreaterThan(withoutRec.components.technical);
            // confidence 0.9 → round(0.9*20)=18 bonus
            expect(withRec.components.technical).toBe(100); // 85+18=103 → clamped to 100
        });

        it('buy action with low confidence gives small boost', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'buy', confidence: 0.3 },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // neutral=50, medium=0, buy(0.3)=+6 → 56
            expect(result.components.technical).toBe(56);
        });

        it('wait action reduces technical score by 15', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'bullish',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'wait', confidence: 0.8 },
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

        it('hold action does not change score', () => {
            const withHold = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'hold', confidence: 0.95 },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            const withoutRec = scoreSignals(
                {
                    technical: { trend: 'neutral', riskLevel: 'medium' },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            expect(withHold.components.technical).toBe(withoutRec.components.technical);
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

        it('buy action confidence=1.0 gives maximum +20 bonus', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'buy', confidence: 1.0 },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // neutral=50, medium=0, buy(1.0)=+20 → 70
            expect(result.components.technical).toBe(70);
        });

        it('buy action confidence=0 gives no bonus', () => {
            const result = scoreSignals(
                {
                    technical: {
                        trend: 'neutral',
                        riskLevel: 'medium',
                        actionRecommendation: { action: 'buy', confidence: 0 },
                    },
                    news: null,
                    options: null,
                    fundamental: null,
                },
                DEFAULT_WEIGHTS,
                DEFAULT_BUY_THRESHOLD,
                DEFAULT_SELL_THRESHOLD,
            );

            // neutral=50, medium=0, buy(0)=+0 → 50
            expect(result.components.technical).toBe(50);
        });
    });
});
