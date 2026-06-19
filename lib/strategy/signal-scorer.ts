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
        technical: scoreTechnical(inputs.technical),
        news: scoreSentiment(inputs.news),
        options: scoreOptions(inputs.options),
        fundamental: scoreFundamental(inputs.fundamental),
    };

    const totalWeight = weights.technical + weights.news + weights.options + weights.fundamental;

    if (totalWeight === 0) {
        return { total: 50, components, signal: 'hold' as const };
    }

    const weightedSum =
        components.technical * weights.technical +
        components.news * weights.news +
        components.options * weights.options +
        components.fundamental * weights.fundamental;

    const total = clamp(Math.round(weightedSum / totalWeight), 0, 100);

    const signal = determineSignal(total, buyThreshold, sellThreshold);

    return { total, components, signal };
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
