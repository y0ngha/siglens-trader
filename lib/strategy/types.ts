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

/**
 * `congress: 0` — 축은 살아 있고 투표만 하지 않는다.
 *
 * 프로덕션 실측(2026-08-07~21, 4종목 31회): `overallSentiment`가 **31/31 전부 `bullish`**.
 * 공시 건수 1건짜리도, 6건짜리도 bullish. 분산이 0인 축은 투표가 아니라 상수 가산점이고,
 * `scoreSentiment`가 그걸 80으로 매핑해 매 틱 모든 종목의 점수를 같은 폭으로 밀어 올렸다.
 * 30Min 프로파일 기준 +1.6점 — 임계 70을 상시 68.4로 낮추는 것과 같다.
 *
 * **LLM이 고장 난 게 아니다.** 실제 페이로드를 보면 판단은 정확하다: 2026-08-20 IONQ의
 * 근거는 "2026-03-18 매수 1건, 1,001~15,000달러, 04-15 공시"였고, 같은 응답의
 * `riskNoteKo`가 스스로 "최대 45일 이상 보고 지연… 정밀한 정량적 신호로 해석해서는 안 된다"고
 * 적었다. 5개월 전의 최소 구간 매수 1건은 30분 결정에 대해 말할 수 있는 게 없고, 인기
 * 기술주의 의회 공시는 구조적으로 순매수 쪽으로 쏠려 있어 이 축은 앞으로도 bullish만 낸다.
 *
 * 아래 독스트링이 이미 "lag, not information"이라 적고도 1~3으로 남겨 뒀던 값을 데이터가
 * 0으로 확정한 것이다. 분석 자체는 계속 돌린다 — 대시보드 맥락이고 사이징 게이트
 * 프롬프트의 입력이다. 점수에만 관여하지 않는다.
 *
 * 되돌리려면 `POST /api/config`로 `score_weights.congress`를 양수로 주면 된다
 * (`sanitizeWeights`가 0을 "투표 없음"으로 읽으므로 0은 껐다는 뜻이다).
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
    confluence: 12,
    technical: 8,
    news: 6,
    options: 5,
    fundamental: 4,
    congress: 0,
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
 * `congress`는 그 논리의 끝까지 가서 모든 프로파일에서 0이다 — 이유는
 * {@link DEFAULT_WEIGHTS} 참고. `fundamental`은 분산이 살아 있어(32~74 관측) 축소만 한다.
 *
 * `1Hour` intentionally equals {@link DEFAULT_WEIGHTS} — it is the existing behaviour, kept
 * as the baseline so this only changes the shorter timeframes.
 *
 * `confluence`(지표 컨플루언스)는 유일하게 LLM을 거치지 않는 축이고, siglens 백테스트에서
 * 이 룰의 승률(70%)이 같은 시점 LLM 판단(61.5%)을 앞섰기 때문에 모든 프로파일에서 최상위
 * 가중치를 갖는다. 호흡이 짧을수록 서술 판단보다 가격행동이 신뢰할 만하므로 15Min에서 더 높다.
 */
export const WEIGHTS_BY_TIMEFRAME: Record<string, ScoreWeights> = {
    '15Min': { confluence: 14, technical: 10, news: 6, options: 6, fundamental: 2, congress: 0 },
    '30Min': { confluence: 13, technical: 9, news: 6, options: 5, fundamental: 3, congress: 0 },
    '1Hour': DEFAULT_WEIGHTS,
};

/** Weights for a timeframe, falling back to the baseline for anything unrecognized. */
export function weightsForTimeframe(timeframe: string): ScoreWeights {
    return WEIGHTS_BY_TIMEFRAME[timeframe] ?? DEFAULT_WEIGHTS;
}

export const DEFAULT_BUY_THRESHOLD = 70;
export const DEFAULT_SELL_THRESHOLD = 30;
