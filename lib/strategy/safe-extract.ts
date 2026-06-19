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

/**
 * Extracts per-indicator signal directions from a technical analysis result
 * (`indicatorResults[].signals[]`). Returns a flat list of {trend, strength}.
 */
export function safeAnalysisIndicators(
    result: unknown,
): Array<{ trend?: string; strength?: string }> {
    const r = safeRecord(result);
    if (!r) return [];
    const indicators = safeArray(r, 'indicatorResults');
    if (!indicators) return [];
    const out: Array<{ trend?: string; strength?: string }> = [];
    for (const ind of indicators) {
        const signals = safeArray(ind, 'signals');
        if (!signals) continue;
        for (const sig of signals) {
            const s = safeRecord(sig);
            if (!s) continue;
            out.push({ trend: safeString(s.trend), strength: safeString(s.strength) });
        }
    }
    return out;
}

/**
 * Extracts per-category sentiments from a fundamental analysis result
 * (`categoryAssessments[]`). Returns a flat list of {sentiment}.
 */
export function safeFundamentalCategories(result: unknown): Array<{ sentiment?: string }> {
    const r = safeRecord(result);
    if (!r) return [];
    const cats = safeArray(r, 'categoryAssessments');
    if (!cats) return [];
    const out: Array<{ sentiment?: string }> = [];
    for (const c of cats) {
        const rec = safeRecord(c);
        if (!rec) continue;
        out.push({ sentiment: safeString(rec.sentiment) });
    }
    return out;
}

export function safeActionRecommendation(
    obj: unknown,
): { entryRecommendation: 'enter' | 'wait' | 'avoid' } | undefined {
    const r = safeRecord(obj);
    if (!r) return undefined;
    const rec = safeRecord(r.actionRecommendation);
    if (!rec) return undefined;
    // siglens-core's ActionRecommendation carries `entryRecommendation` ('enter' | 'wait' | 'avoid'); no confidence field.
    const entryRecommendation = safeString(rec.entryRecommendation);
    if (
        entryRecommendation !== 'enter' &&
        entryRecommendation !== 'wait' &&
        entryRecommendation !== 'avoid'
    ) {
        return undefined;
    }
    return { entryRecommendation };
}
