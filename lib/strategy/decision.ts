import type { SignalScore, TradingSignal } from './types.js';

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

    if (signalScore.signal === 'buy' && hasOpenPosition && calculatedSize > 0) {
        return {
            action: 'average_in',
            symbol,
            score: signalScore.total,
            reason: buildReason(signalScore, 'AVERAGE_IN'),
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
    const actionKo =
        action === 'BUY'
            ? '매수'
            : action === 'SELL'
              ? '매도'
              : action === 'AVERAGE_IN'
                ? '추가 매수'
                : '대기';
    return `신호 ${score.total}/100 — ${actionKo} (기술:${components.technical}, 뉴스:${components.news}, 옵션:${components.options}, 펀더멘털:${components.fundamental}, 종합:${components.overall})`;
}
