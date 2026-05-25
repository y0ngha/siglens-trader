import { describe, it, expect } from 'vitest';
import { makeTradeDecision } from '../decision';
import type { DecisionContext } from '../decision';
import type { SignalScore } from '../types';

function createSignalScore(overrides: Partial<SignalScore> = {}): SignalScore {
    return {
        total: 75,
        components: {
            technical: 80,
            news: 70,
            options: 65,
            fundamental: 60,
            overall: 75,
        },
        signal: 'buy',
        ...overrides,
    };
}

function createContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
    return {
        symbol: 'AAPL',
        signalScore: createSignalScore(),
        hasOpenPosition: false,
        positionQuantity: 0,
        calculatedSize: 10,
        ...overrides,
    };
}

describe('makeTradeDecision', () => {
    describe('BUY decisions', () => {
        it('returns buy when signal is buy, no open position, and calculatedSize > 0', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 80 }),
                hasOpenPosition: false,
                calculatedSize: 5,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('buy');
            expect(result.symbol).toBe('AAPL');
            expect(result.score).toBe(80);
            expect(result.quantity).toBe(5);
        });

        it('uses calculatedSize as buy quantity', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy' }),
                hasOpenPosition: false,
                calculatedSize: 42,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('buy');
            expect(result.quantity).toBe(42);
        });

        it('returns average_in when buy signal with existing position and calculatedSize > 0', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 85 }),
                hasOpenPosition: true,
                positionQuantity: 20,
                calculatedSize: 10,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('average_in');
            expect(result.quantity).toBe(10);
            expect(result.score).toBe(85);
            expect(result.reason).toContain('추가 매수');
        });

        it('returns hold when buy signal with existing position but calculatedSize is 0', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 85 }),
                hasOpenPosition: true,
                positionQuantity: 20,
                calculatedSize: 0,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('hold');
            expect(result.quantity).toBe(0);
        });

        it('is blocked when calculatedSize is 0 — returns hold', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 75 }),
                hasOpenPosition: false,
                calculatedSize: 0,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('hold');
            expect(result.quantity).toBe(0);
        });
    });

    describe('SELL decisions', () => {
        it('returns sell when signal is sell and has open position', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'sell', total: 20 }),
                hasOpenPosition: true,
                positionQuantity: 15,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('sell');
            expect(result.symbol).toBe('AAPL');
            expect(result.score).toBe(20);
            expect(result.quantity).toBe(15);
        });

        it('uses positionQuantity as sell quantity', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'sell', total: 25 }),
                hasOpenPosition: true,
                positionQuantity: 100,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('sell');
            expect(result.quantity).toBe(100);
        });

        it('is blocked when no open position — returns hold', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'sell', total: 15 }),
                hasOpenPosition: false,
                positionQuantity: 0,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('hold');
            expect(result.quantity).toBe(0);
        });
    });

    describe('HOLD decisions', () => {
        it('returns hold when signal is hold regardless of position state (no position)', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'hold', total: 50 }),
                hasOpenPosition: false,
                positionQuantity: 0,
                calculatedSize: 10,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('hold');
            expect(result.quantity).toBe(0);
        });

        it('returns hold when signal is hold regardless of position state (has position)', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'hold', total: 55 }),
                hasOpenPosition: true,
                positionQuantity: 30,
                calculatedSize: 5,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('hold');
            expect(result.quantity).toBe(0);
        });
    });

    describe('reason string', () => {
        it('includes score value and component breakdown for buy', () => {
            const signalScore = createSignalScore({
                signal: 'buy',
                total: 82,
                components: {
                    technical: 90,
                    news: 75,
                    options: 80,
                    fundamental: 70,
                    overall: 85,
                },
            });
            const ctx = createContext({ signalScore, hasOpenPosition: false, calculatedSize: 5 });

            const result = makeTradeDecision(ctx);

            expect(result.reason).toBe(
                '신호 82/100 — 매수 (기술:90, 뉴스:75, 옵션:80, 펀더멘털:70, 종합:85)',
            );
        });

        it('includes score value and component breakdown for sell', () => {
            const signalScore = createSignalScore({
                signal: 'sell',
                total: 18,
                components: {
                    technical: 10,
                    news: 20,
                    options: 15,
                    fundamental: 25,
                    overall: 20,
                },
            });
            const ctx = createContext({
                signalScore,
                hasOpenPosition: true,
                positionQuantity: 7,
            });

            const result = makeTradeDecision(ctx);

            expect(result.reason).toBe(
                '신호 18/100 — 매도 (기술:10, 뉴스:20, 옵션:15, 펀더멘털:25, 종합:20)',
            );
        });

        it('includes score value and component breakdown for hold', () => {
            const signalScore = createSignalScore({
                signal: 'hold',
                total: 50,
                components: {
                    technical: 50,
                    news: 50,
                    options: 50,
                    fundamental: 50,
                    overall: 50,
                },
            });
            const ctx = createContext({ signalScore });

            const result = makeTradeDecision(ctx);

            expect(result.reason).toBe(
                '신호 50/100 — 대기 (기술:50, 뉴스:50, 옵션:50, 펀더멘털:50, 종합:50)',
            );
        });
    });

    describe('symbol passthrough', () => {
        it('preserves the symbol in all decision types', () => {
            const symbols = ['TSLA', 'NVDA', 'MSFT'];

            for (const symbol of symbols) {
                const ctx = createContext({
                    symbol,
                    signalScore: createSignalScore({ signal: 'hold', total: 50 }),
                });

                const result = makeTradeDecision(ctx);
                expect(result.symbol).toBe(symbol);
            }
        });
    });

    describe('edge cases', () => {
        it('buy with calculatedSize of 1 (minimum viable buy)', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 71 }),
                hasOpenPosition: false,
                calculatedSize: 1,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('buy');
            expect(result.quantity).toBe(1);
        });

        it('sell with positionQuantity of 1 (minimum viable sell)', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'sell', total: 29 }),
                hasOpenPosition: true,
                positionQuantity: 1,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('sell');
            expect(result.quantity).toBe(1);
        });

        it('score of 0 with sell signal and open position still sells', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'sell', total: 0 }),
                hasOpenPosition: true,
                positionQuantity: 50,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('sell');
            expect(result.score).toBe(0);
        });

        it('score of 100 with buy signal and no position still buys', () => {
            const ctx = createContext({
                signalScore: createSignalScore({ signal: 'buy', total: 100 }),
                hasOpenPosition: false,
                calculatedSize: 25,
            });

            const result = makeTradeDecision(ctx);

            expect(result.action).toBe('buy');
            expect(result.score).toBe(100);
        });
    });
});
