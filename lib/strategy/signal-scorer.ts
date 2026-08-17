import { scoreConfluence } from './confluence.js';
import type { ConfluenceSnapshot } from './confluence.js';
import type { ScoreWeights, SignalDirection, SignalScore } from './types.js';

// Pseudo-count for options score shrinkage — pulls small signal samples toward 50.
const OPTIONS_SHRINK_K = 1;

// Score span around the neutral midpoint (50). Kept equal to the legacy discrete
// extremes so aggregated scores stay in the same range, just continuous:
//   technical trend: 50 ± 35 → 15..85   |   fundamental: 50 ± 30 → 20..80
const TREND_SPAN = 35;
const FUND_SPAN = 30;

export interface ActionRecommendation {
    // siglens-core's technical analysis emits `entryRecommendation` (no confidence field).
    entryRecommendation: 'enter' | 'wait' | 'avoid';
}

/** `patternSummaries` / `strategyResults` / `candlePatterns`의 공통 최소 형태. */
export interface WeightedTrendSignal {
    trend?: string;
    /** core가 스킬 카탈로그에서 상속시킨 신뢰도 가중치. 없으면 1로 센다. */
    confidenceWeight?: number;
    /** `candlePatterns` / `patternSummaries`는 미검출 항목도 배열에 남긴다. */
    detected?: boolean;
}

export interface AnalysisInputs {
    /**
     * 지표 컨플루언스 스냅샷 (LLM이 아니라 규칙이 만든 축).
     * 봉을 못 받았거나 계산에 실패하면 `null`이고, 그때는 이 축이 투표하지 않는다.
     */
    confluence?: ConfluenceSnapshot | null;
    technical: {
        trend?: string;
        riskLevel?: string;
        actionRecommendation?: ActionRecommendation;
        // Per-indicator signals (siglens-core `indicatorResults`); aggregated for a continuous score.
        indicators?: Array<{ trend?: string; strength?: string }>;
        /**
         * `patternSummaries` + `strategyResults` + `candlePatterns`를 합친 목록.
         * core가 방향과 `confidenceWeight`까지 붙여 내는데 여태 어디서도 읽히지 않았다.
         */
        patterns?: WeightedTrendSignal[];
    } | null;
    news: { overallSentiment?: string } | null;
    // siglens-core's OptionsSignalKind: 'bullish' | 'bearish' | 'neutral' | 'volatility'.
    options: { signals?: Array<{ kind?: string }> } | null;
    // `categories` from siglens-core `categoryAssessments`; aggregated for a continuous score.
    fundamental: { overallSentiment?: string; categories?: Array<{ sentiment?: string }> } | null;
    // CongressTrendResponse.overallSentiment: 'bullish' | 'neutral' | 'bearish'.
    // Reuses scoreSentiment — congress response carries the same three-valued field as news.
    // Optional for backward compatibility: callers that pre-date congress can omit the field.
    congress?: { overallSentiment?: string } | null;
}

/**
 * Scores analysis inputs into a 0-100 signal score with a buy/sell/hold decision.
 *
 * Each analysis type produces a component score (0-100), then a weighted average
 * determines the final score. The signal is derived from threshold comparison.
 */
export function scoreSignals(
    inputs: AnalysisInputs,
    weights: ScoreWeights,
    buyThreshold: number,
    sellThreshold: number,
): SignalScore {
    const components = {
        confluence: scoreConfluence(inputs.confluence ?? null),
        technical: scoreTechnical(inputs.technical),
        news: scoreSentiment(inputs.news),
        options: scoreOptions(inputs.options),
        fundamental: scoreFundamental(inputs.fundamental),
        // congress shares scoreSentiment — CongressTrendResponse.overallSentiment is the same
        // 'bullish'|'neutral'|'bearish' shape as news, so no separate scorer is needed.
        congress: scoreSentiment(inputs.congress ?? null),
    };

    // Congress only votes when disclosures actually exist. Most symbols have none, so a
    // constant neutral 50 carrying weight would dilute every other signal: with the other
    // four at their extremes and congress absent, the aggregate is pulled ~2 points toward
    // 50, which raises the bar for BOTH entries and exits — a signal that makes the system
    // less decisive by being added is worse than no signal. The other four always produce a
    // verdict once their cron has run, so they keep voting unconditionally (excluding them
    // when null would instead let a single component clear the threshold on its own).
    const congressWeight = inputs.congress ? weights.congress : 0;

    // congress와 같은 조건부 투표. 봉 조회가 실패한 심볼에서 중립 50이 최상위 가중치로
    // 투표하면 다른 축의 신호를 12/38만큼 50 쪽으로 끌어내려, FMP 장애가 곧 "아무것도
    // 사거나 팔지 않음"이 된다. 데이터가 없으면 말을 하지 않는 쪽이 옳다.
    const confluenceWeight = inputs.confluence ? weights.confluence : 0;

    const totalWeight =
        confluenceWeight +
        weights.technical +
        weights.news +
        weights.options +
        weights.fundamental +
        congressWeight;

    if (totalWeight === 0) {
        return { total: 50, totalWithoutConfluence: 50, components, signal: 'hold' as const };
    }

    const weightedSum =
        components.confluence * confluenceWeight +
        components.technical * weights.technical +
        components.news * weights.news +
        components.options * weights.options +
        components.fundamental * weights.fundamental +
        components.congress * congressWeight;

    const total = clamp(Math.round(weightedSum / totalWeight), 0, 100);

    // 컨플루언스는 매수를 막을 수 있어도 매도를 막지 못한다.
    //
    // 축을 하나 더하면 분모가 커져 매수와 매도 양쪽 문턱이 대칭으로 올라간다. 매수가
    // 어려워지는 건 이 축을 넣은 목적이지만(지표가 받쳐주지 않는 진입은 하지 않는다),
    // 매도가 어려워지는 건 정반대다. 놓친 매수는 기회비용이고 놓친 매도는 실현 손실이다 —
    // AI 사이징 게이트가 진입 fail-closed / 청산 fail-open으로 갈라놓은 그 비대칭이
    // 점수 단계에도 그대로 적용돼야 한다.
    //
    // 구체적으로 위험한 조합: 뉴스·펀더멘털이 무너져 기존 축 합성이 매도인데 하락이 아직
    // 가격에 반영되지 않아 단기 지표만 우호적인 종목. 이때 technicalTrend는 아직 bearish가
    // 아니라 evaluateExistingPosition도 잡지 못하고, fixed_exit_enabled는 기본 off다.
    // 신호 매도가 유일한 출구인데 컨플루언스가 그걸 hold로 덮으면 청산 경로가 통째로 사라진다.
    //
    // 그래서 컨플루언스를 뺀 점수가 매도였다면 매도를 유지한다. 반대로 컨플루언스가
    // 하락 트리거로 점수를 끌어내려 새로 매도가 서는 것은 그대로 허용한다 — 청산을
    // 쉽게 만드는 방향은 막을 이유가 없다.
    const signal = determineSignal(total, buyThreshold, sellThreshold);

    // 컨플루언스를 뺀 점수는 감사에도 남는다(`SignalScore.totalWithoutConfluence`). 보정이
    // 걸린 행은 `total`이 매도 임계값을 크게 웃도는데 `signal='sell'`이라, 이 값이 없으면
    // 나중에 그 행을 보는 사람이 정상 보정과 버그를 구분할 수 없다.
    const totalWithoutConfluence =
        confluenceWeight > 0 && totalWeight > confluenceWeight
            ? clamp(
                  Math.round(
                      (weightedSum - components.confluence * confluenceWeight) /
                          (totalWeight - confluenceWeight),
                  ),
                  0,
                  100,
              )
            : total;
    const signalWithoutConfluence = determineSignal(
        totalWithoutConfluence,
        buyThreshold,
        sellThreshold,
    );

    // 컨플루언스가 기권하면 매수를 열지 않는다 (매도는 그대로).
    //
    // 기권은 가중치 12를 분모에서 빼는데, 그 결과는 "이 축 도입 이전과 동일"이 아니라
    // **더 느슨한 쪽**이다. 다른 5축을 고정하고 재보면 같은 종목이 컨플루언스 50(진짜 중립)일
    // 때 65(hold)인데 스냅샷이 null이면 72(buy)가 된다 — 시장은 하나도 변하지 않았고 FMP가
    // 봉을 못 줬을 뿐이다. 지표가 받쳐주지 않는 진입은 하지 않겠다고 넣은 축이 정작
    // **지표를 확인할 수 없을 때 통째로 열리는** 구조였다.
    //
    // 그래서 매수만 hold로 내린다. 매도·청산은 건드리지 않는다 — 놓친 매수는 기회비용,
    // 놓친 매도는 실현 손실이라는 이 저장소의 비대칭(원칙 7, 게이트 설계 §8)과 같은 방향이다.
    const corrected = signalWithoutConfluence === 'sell' ? 'sell' : signal;
    const confluenceAbstained = inputs.confluence == null;

    return {
        total,
        totalWithoutConfluence,
        components,
        signal: confluenceAbstained && corrected === 'buy' ? 'hold' : corrected,
    };
}

function scoreTechnical(
    input: {
        trend?: string;
        riskLevel?: string;
        actionRecommendation?: ActionRecommendation;
        indicators?: Array<{ trend?: string; strength?: string }>;
        patterns?: WeightedTrendSignal[];
    } | null,
): number {
    if (!input) return 50;

    const trendScore = technicalTrendScore(input);
    const riskModifier = mapRiskLevel(input.riskLevel);
    const recommendationModifier = mapActionRecommendation(input.actionRecommendation);

    return clamp(Math.round(trendScore + riskModifier + recommendationModifier), 0, 100);
}

/**
 * 기술 축의 방향 점수.
 *
 * 세 재료를 **평균**한다 — 시그널 집계, 패턴/전략/캔들 집계, 그리고 LLM의 종합 `trend`.
 *
 * 종전에는 `mapTrend(trend)`가 "시그널이 하나도 없을 때"의 폴백이었는데, core 스키마에서
 * `indicatorResults`는 required이고 항상 배열로 정규화되므로 그 폴백은 실전에서 도달하지
 * 않는 죽은 코드였다. 결과적으로 분석의 가장 종합적인 판정이 진입 점수에서 통째로 버려지고
 * 있었다 — 그런데 같은 값이 `evaluateExistingPosition({ technicalTrend })`에서는 청산 판단에
 * 쓰인다. **진입은 시그널 카운트를, 청산은 종합 판정을 보는** 상태였다. 평균을 내면 두 경로가
 * 같은 근거를 본다.
 *
 * `patterns`(patternSummaries + strategyResults + candlePatterns)도 여기서 처음 배선된다.
 * core가 `confidenceWeight`까지 계산해 주는 방향 신호 세 묶음이 그동안 읽히지 않았다.
 */
function technicalTrendScore(input: {
    trend?: string;
    indicators?: Array<{ trend?: string; strength?: string }>;
    patterns?: WeightedTrendSignal[];
}): number {
    const parts: number[] = [];

    const signalAgg = aggregateDirection(
        input.indicators ?? [],
        (i) => directionOf(i.trend),
        (i) => strengthWeight(i.strength),
    );
    if (signalAgg !== null) parts.push(50 + signalAgg * TREND_SPAN);

    const patternAgg = aggregateDirection(
        // 미검출 항목은 방향을 주장하지 않는다 — 분모에 넣으면 카탈로그 크기가 곧 희석이 된다.
        (input.patterns ?? []).filter((p) => p.detected !== false),
        (p) => directionOf(p.trend),
        (p) => (isFinitePositiveNumber(p.confidenceWeight) ? p.confidenceWeight : 1),
    );
    if (patternAgg !== null) parts.push(50 + patternAgg * TREND_SPAN);

    const overall = directionOf(input.trend);
    if (overall !== null) parts.push(mapTrend(input.trend));

    if (parts.length === 0) return 50;
    return parts.reduce((sum, v) => sum + v, 0) / parts.length;
}

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * `entryRecommendation` 수정자. 폭을 ±20~25에서 ±10~12로 줄였다.
 *
 * 종전 폭 45점(enter +20 ~ avoid −25)은 `TREND_SPAN` ±35 = 70점의 64%라, 리터럴 한 단어가
 * 지표 집계 전체를 뒤집었다: 지표가 100% 강세인데 `avoid`면 60, 지표가 완전 중립인데
 * `enter`면 70. 더 나쁜 것은 중립점 이동이었다 — 6축이 전부 중립인 종목이 `avoid` 하나로
 * 합성 45가 되어, **매수는 임계까지 +25가 필요하고 매도는 −15면 되는** 비대칭이 생겼다.
 * `entryRecommendation`은 강세장에서도 과열이면 `wait`이 나오는 필드라 이 편향이 상시적이다.
 *
 * `avoid`는 이제 점수가 아니라 진입 게이트(`execute.ts`의 `entry_not_recommended`)가 막는다.
 * 명시적 거부를 5점짜리 감점으로 표현하려던 것이 애초에 잘못된 층이었다.
 */
function mapActionRecommendation(rec: ActionRecommendation | undefined): number {
    if (!rec) return 0;

    switch (rec.entryRecommendation) {
        case 'enter':
            return 10;
        case 'wait':
            return -6;
        case 'avoid':
            return -12;
    }
}

function mapTrend(trend: string | undefined): number {
    switch (trend) {
        case 'bullish':
            return 85;
        case 'bearish':
            return 15;
        case 'neutral':
        default:
            return 50;
    }
}

function mapRiskLevel(riskLevel: string | undefined): number {
    switch (riskLevel) {
        case 'low':
            return 10;
        case 'high':
            return -10;
        case 'medium':
        default:
            return 0;
    }
}

function scoreSentiment(input: { overallSentiment?: string } | null): number {
    if (!input) return 50;

    switch (input.overallSentiment) {
        case 'bullish':
            return 80;
        case 'bearish':
            return 20;
        case 'neutral':
        default:
            return 50;
    }
}

// Aggregate per-category sentiments → continuous score; fall back to overallSentiment.
function scoreFundamental(
    input: { overallSentiment?: string; categories?: Array<{ sentiment?: string }> } | null,
): number {
    if (!input) return 50;

    const agg = aggregateDirection(
        input.categories ?? [],
        (c) => directionOf(c.sentiment),
        () => 1,
    );
    if (agg === null) return scoreSentiment(input);
    return clamp(Math.round(50 + agg * FUND_SPAN), 0, 100);
}

// Maps a bullish/bearish/neutral label to a direction; null for unknown/missing.
function directionOf(label: string | undefined): number | null {
    switch (label) {
        case 'bullish':
            return 1;
        case 'bearish':
            return -1;
        case 'neutral':
            return 0;
        default:
            return null;
    }
}

// Indicator strength → weight; unknown/missing strength counts as moderate.
function strengthWeight(strength: string | undefined): number {
    switch (strength) {
        case 'strong':
            return 3;
        case 'weak':
            return 1;
        case 'moderate':
        default:
            return 2;
    }
}

// Weighted mean of signal directions in [-1, 1]; null when no usable signal exists.
// Neutral signals (direction 0) are counted in the denominator, diluting strength.
function aggregateDirection<T>(
    items: T[],
    dirOf: (item: T) => number | null,
    weightOf: (item: T) => number,
): number | null {
    let num = 0;
    let den = 0;
    for (const item of items) {
        const dir = dirOf(item);
        if (dir === null) continue;
        const w = weightOf(item);
        num += dir * w;
        den += w;
    }
    if (den === 0) return null;
    return num / den;
}

function scoreOptions(input: { signals?: Array<{ kind?: string }> } | null): number {
    if (!input) return 50;

    const signals = input.signals;
    if (!signals || signals.length === 0) return 50;

    let bullishCount = 0;
    let bearishCount = 0;

    for (const signal of signals) {
        if (signal.kind === 'bullish') bullishCount++;
        else if (signal.kind === 'bearish') bearishCount++;
    }

    // Only directional signals drive the ratio; neutral/volatility kinds are ignored.
    const directional = bullishCount + bearishCount;
    if (directional === 0) return 50;

    // Shrinkage (pseudo-count): a single directional signal shouldn't snap to 0/100.
    // The +1 pulls small samples toward 50; larger samples approach the raw ratio.
    const ratio = (bullishCount - bearishCount) / (directional + OPTIONS_SHRINK_K);
    return clamp(Math.round(50 + ratio * 50), 0, 100);
}

function determineSignal(
    score: number,
    buyThreshold: number,
    sellThreshold: number,
): SignalDirection {
    if (score >= buyThreshold) return 'buy';
    if (score <= sellThreshold) return 'sell';
    return 'hold';
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
