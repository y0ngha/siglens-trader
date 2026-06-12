import { isFinitePositive } from '../validation.js';

/**
 * Safe extraction helpers for untyped AI analysis results.
 * These functions defensively parse nested JSON returned by LLM analysis
 * and return safe default values instead of throwing on unexpected shapes.
 */

export function safeRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return null;
}

export function safeString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function safeAnalysisPrice(result: unknown): number {
    const r = safeRecord(result);
    if (!r) return 0;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return 0;
    const price = keyLevels.currentPrice;
    return isFinitePositive(price) ? price : 0;
}

export function safeAnalysisTrend(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.trend) : undefined;
}

export function safeAnalysisSentiment(result: unknown): string | undefined {
    const r = safeRecord(result);
    return r ? safeString(r.overallSentiment) : undefined;
}

export function safeNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const nums = value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return nums.length > 0 ? nums : undefined;
}

export function safeAnalysisSupport(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safeNumberArray(keyLevels.support);
    return levels?.[0];
}

export function safeAnalysisResistance(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const keyLevels = safeRecord(r.keyLevels);
    if (!keyLevels) return undefined;
    const levels = safeNumberArray(keyLevels.resistance);
    return levels?.[0];
}

export function safeAnalysisTargetPrice(result: unknown): number | undefined {
    const r = safeRecord(result);
    if (!r) return undefined;
    const priceTargets = safeRecord(r.priceTargets);
    if (!priceTargets) return undefined;
    const bullish = safeRecord(priceTargets.bullish);
    if (!bullish) return undefined;
    const target = bullish.target;
    return isFinitePositive(target) ? target : undefined;
}

export function safeArray(obj: unknown, key: string): unknown[] | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const val = r[key];
    return Array.isArray(val) ? val : undefined;
}

export function safeActionRecommendation(
    obj: unknown,
): { action: 'buy' | 'hold' | 'wait'; confidence: number } | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const rec = safeRecord(r.actionRecommendation);
    if (!rec) return undefined;
    const action = safeString(rec.action);
    if (action !== 'buy' && action !== 'hold' && action !== 'wait') return undefined;
    const confidence =
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? rec.confidence : 0;
    return { action, confidence };
}
