import type { ScoreWeights, SignalDirection, SignalScore } from './types.js';

export interface ActionRecommendation {
    action: 'buy' | 'hold' | 'wait';
    confidence: number; // 0-1
}

export interface AnalysisInputs {
    technical: {
        trend?: string;
        riskLevel?: string;
        actionRecommendation?: ActionRecommendation;
    } | null;
    news: { overallSentiment?: string } | null;
    options: { signals?: Array<{ type?: string }> } | null;
    fundamental: { overallSentiment?: string } | null;
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
        fundamental: scoreSentiment(inputs.fundamental),
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
    } | null,
): number {
    if (!input) return 50;

    const trendScore = mapTrend(input.trend);
    const riskModifier = mapRiskLevel(input.riskLevel);
    const recommendationModifier = mapActionRecommendation(input.actionRecommendation);

    return clamp(trendScore + riskModifier + recommendationModifier, 0, 100);
}

function mapActionRecommendation(rec: ActionRecommendation | undefined): number {
    if (!rec) return 0;

    switch (rec.action) {
        case 'buy':
            return Math.round(rec.confidence * 20);
        case 'wait':
            return -15;
        case 'hold':
        default:
            return 0;
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

function scoreOptions(input: { signals?: Array<{ type?: string }> } | null): number {
    if (!input) return 50;

    const signals = input.signals;
    if (!signals || signals.length === 0) return 50;

    let bullishCount = 0;
    let bearishCount = 0;

    for (const signal of signals) {
        if (signal.type === 'bullish') bullishCount++;
        else if (signal.type === 'bearish') bearishCount++;
    }

    const ratio = (bullishCount - bearishCount) / signals.length;
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
