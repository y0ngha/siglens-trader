/** Signal direction emitted by the scoring engine (buy / sell / hold). */
export type SignalDirection = 'buy' | 'sell' | 'hold';

/** Trade action including the derived `average_in` produced by the decision layer. */
export type TradingSignal = 'buy' | 'sell' | 'hold' | 'average_in';

export interface SignalScore {
    total: number; // 0-100
    components: {
        technical: number;
        news: number;
        options: number;
        fundamental: number;
        congress: number;
    };
    signal: SignalDirection;
}

export interface ScoreWeights {
    technical: number;
    news: number;
    options: number;
    fundamental: number;
    congress: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
    technical: 8,
    news: 6,
    options: 5,
    fundamental: 4,
    congress: 3,
};

/**
 * Default weights per analysis timeframe.
 *
 * A signal is only worth what it can say about the horizon being traded. Congressional
 * disclosures surface weeks after the trade and quarterly fundamentals move on a scale of
 * months — letting them vote as loudly on a 15-minute decision as on an hourly one adds
 * lag, not information. So the slow components shrink as the horizon shortens and price
 * action (technical, options flow) takes over.
 *
 * `1Hour` intentionally equals {@link DEFAULT_WEIGHTS} — it is the existing behaviour, kept
 * as the baseline so this only changes the shorter timeframes.
 */
export const WEIGHTS_BY_TIMEFRAME: Record<string, ScoreWeights> = {
    '15Min': { technical: 10, news: 6, options: 6, fundamental: 2, congress: 1 },
    '30Min': { technical: 9, news: 6, options: 5, fundamental: 3, congress: 2 },
    '1Hour': DEFAULT_WEIGHTS,
};

/** Weights for a timeframe, falling back to the baseline for anything unrecognized. */
export function weightsForTimeframe(timeframe: string): ScoreWeights {
    return WEIGHTS_BY_TIMEFRAME[timeframe] ?? DEFAULT_WEIGHTS;
}

export const DEFAULT_BUY_THRESHOLD = 70;
export const DEFAULT_SELL_THRESHOLD = 30;
