import type { SignalScore, TradingSignal } from './types';

export interface TradeDecision {
    action: TradingSignal;
    symbol: string;
    score: number;
    reason: string;
    quantity: number;
}

export interface DecisionContext {
    symbol: string;
    signalScore: SignalScore;
    hasOpenPosition: boolean;
    positionQuantity: number;
    calculatedSize: number;
}

export function makeTradeDecision(ctx: DecisionContext): TradeDecision {
    const { symbol, signalScore, hasOpenPosition, positionQuantity, calculatedSize } = ctx;

    if (signalScore.signal === 'buy' && !hasOpenPosition && calculatedSize > 0) {
        return {
            action: 'buy',
            symbol,
            score: signalScore.total,
            reason: buildReason(signalScore, 'BUY'),
            quantity: calculatedSize,
        };
    }

    if (signalScore.signal === 'sell' && hasOpenPosition) {
        return {
            action: 'sell',
            symbol,
            score: signalScore.total,
            reason: buildReason(signalScore, 'SELL'),
            quantity: positionQuantity,
        };
    }

    return {
        action: 'hold',
        symbol,
        score: signalScore.total,
        reason: buildReason(signalScore, 'HOLD'),
        quantity: 0,
    };
}

function buildReason(score: SignalScore, action: string): string {
    const { components } = score;
    return `Score ${score.total}/100 — ${action} (tech:${components.technical}, news:${components.news}, opt:${components.options}, fund:${components.fundamental}, overall:${components.overall})`;
}
