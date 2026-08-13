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
        return { total: 50, components, signal: 'hold' as const };
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
    const signalWithoutConfluence =
        confluenceWeight > 0 && totalWeight > confluenceWeight
            ? determineSignal(
                  clamp(
                      Math.round(
                          (weightedSum - components.confluence * confluenceWeight) /
                              (totalWeight - confluenceWeight),
                      ),
                      0,
                      100,
                  ),
                  buyThreshold,
                  sellThreshold,
              )
            : signal;

    return {
        total,
        components,
        signal: signalWithoutConfluence === 'sell' ? 'sell' : signal,
    };
}

function scoreTechnical(
    input: {
        trend?: string;
        riskLevel?: string;
        actionRecommendation?: ActionRecommendation;
        indicators?: Array<{ trend?: string; strength?: string }>;
    } | null,
): number {
    if (!input) return 50;

    const trendScore = technicalTrendScore(input);
    const riskModifier = mapRiskLevel(input.riskLevel);
    const recommendationModifier = mapActionRecommendation(input.actionRecommendation);

    return clamp(Math.round(trendScore + riskModifier + recommendationModifier), 0, 100);
}

// Strength-weighted aggregate of per-indicator signals → continuous trend score.
// Falls back to the single top-level trend when no indicator signals are usable.
function technicalTrendScore(input: {
    trend?: string;
    indicators?: Array<{ trend?: string; strength?: string }>;
}): number {
    const agg = aggregateDirection(
        input.indicators ?? [],
        (i) => directionOf(i.trend),
        (i) => strengthWeight(i.strength),
    );
    if (agg === null) return mapTrend(input.trend);
    return 50 + agg * TREND_SPAN;
}

function mapActionRecommendation(rec: ActionRecommendation | undefined): number {
    if (!rec) return 0;

    switch (rec.entryRecommendation) {
        case 'enter':
            return 20;
        case 'wait':
            return -15;
        case 'avoid':
            return -25;
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
