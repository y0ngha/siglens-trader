/** Signal direction emitted by the scoring engine (buy / sell / hold). */
export type SignalDirection = 'buy' | 'sell' | 'hold';

/** Trade action including the derived `average_in` produced by the decision layer. */
export type TradingSignal = 'buy' | 'sell' | 'hold' | 'average_in';

export interface SignalScore {
    total: number; // 0-100
    /**
     * 컨플루언스 축을 뺀 가중 평균.
     *
     * 컨플루언스는 매수를 막을 수 있어도 매도를 막지 못한다(`signal-scorer.ts` 참조).
     * 그 보정이 걸리면 `total`은 매도 임계값을 한참 웃도는데 `signal`은 `sell`이 되어,
     * 저장된 숫자만으로는 매도가 재현되지 않는다. 이 값이 그 판정의 실제 근거다.
     * 컨플루언스가 투표하지 않을 때는 `total`과 같다.
     */
    totalWithoutConfluence: number;
    components: {
        confluence: number;
        technical: number;
        news: number;
        options: number;
        fundamental: number;
        congress: number;
    };
    signal: SignalDirection;
}

export interface ScoreWeights {
    confluence: number;
    technical: number;
    news: number;
    options: number;
    fundamental: number;
    congress: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
    confluence: 12,
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
 *
 * `confluence`(지표 컨플루언스)는 유일하게 LLM을 거치지 않는 축이고, siglens 백테스트에서
 * 이 룰의 승률(70%)이 같은 시점 LLM 판단(61.5%)을 앞섰기 때문에 모든 프로파일에서 최상위
 * 가중치를 갖는다. 호흡이 짧을수록 서술 판단보다 가격행동이 신뢰할 만하므로 15Min에서 더 높다.
 */
export const WEIGHTS_BY_TIMEFRAME: Record<string, ScoreWeights> = {
    '15Min': { confluence: 14, technical: 10, news: 6, options: 6, fundamental: 2, congress: 1 },
    '30Min': { confluence: 13, technical: 9, news: 6, options: 5, fundamental: 3, congress: 2 },
    '1Hour': DEFAULT_WEIGHTS,
};

/** Weights for a timeframe, falling back to the baseline for anything unrecognized. */
export function weightsForTimeframe(timeframe: string): ScoreWeights {
    return WEIGHTS_BY_TIMEFRAME[timeframe] ?? DEFAULT_WEIGHTS;
}

export const DEFAULT_BUY_THRESHOLD = 70;
export const DEFAULT_SELL_THRESHOLD = 30;
