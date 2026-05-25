export type TradingSignal = 'buy' | 'sell' | 'hold' | 'average_in';

export interface SignalScore {
    total: number; // 0-100
    components: {
        technical: number;
        news: number;
        options: number;
        fundamental: number;
        overall: number;
    };
    signal: TradingSignal;
}

export interface ScoreWeights {
    technical: number;
    news: number;
    options: number;
    fundamental: number;
    overall: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
    technical: 8,
    news: 6,
    options: 5,
    fundamental: 4,
    overall: 3,
};

export const DEFAULT_BUY_THRESHOLD = 70;
export const DEFAULT_SELL_THRESHOLD = 30;
