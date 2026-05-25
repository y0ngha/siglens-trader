import { describe, it, expect } from 'vitest';
import {
    safeRecord,
    safeString,
    safeAnalysisPrice,
    safeAnalysisTrend,
    safeAnalysisSentiment,
    safeAnalysisSupport,
    safeAnalysisResistance,
    safeAnalysisTargetPrice,
    safeActionRecommendation,
    safeArray,
    safeNumberArray,
} from '../safe-extract';

describe('safeRecord', () => {
    it('returns object as Record when valid', () => {
        expect(safeRecord({ a: 1 })).toEqual({ a: 1 });
    });

    it('returns null for null', () => {
        expect(safeRecord(null)).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(safeRecord(undefined)).toBeNull();
    });

    it('returns null for arrays', () => {
        expect(safeRecord([1, 2, 3])).toBeNull();
    });

    it('returns null for strings', () => {
        expect(safeRecord('hello')).toBeNull();
    });

    it('returns null for numbers', () => {
        expect(safeRecord(42)).toBeNull();
    });

    it('returns null for booleans', () => {
        expect(safeRecord(true)).toBeNull();
    });
});

describe('safeAnalysisPrice', () => {
    it('extracts currentPrice from valid structure', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: 150 } })).toBe(150);
    });

    it('returns 0 for null input', () => {
        expect(safeAnalysisPrice(null)).toBe(0);
    });

    it('returns 0 for undefined input', () => {
        expect(safeAnalysisPrice(undefined)).toBe(0);
    });

    it('returns 0 when keyLevels is missing', () => {
        expect(safeAnalysisPrice({})).toBe(0);
    });

    it('returns 0 when keyLevels is not an object', () => {
        expect(safeAnalysisPrice({ keyLevels: 'invalid' })).toBe(0);
    });

    it('returns 0 when keyLevels is an array', () => {
        expect(safeAnalysisPrice({ keyLevels: [150] })).toBe(0);
    });

    it('returns 0 when currentPrice is 0', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: 0 } })).toBe(0);
    });

    it('returns 0 when currentPrice is negative', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: -10 } })).toBe(0);
    });

    it('returns 0 when currentPrice is NaN', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: NaN } })).toBe(0);
    });

    it('returns 0 when currentPrice is Infinity', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: Infinity } })).toBe(0);
    });

    it('returns 0 when currentPrice is a string', () => {
        expect(safeAnalysisPrice({ keyLevels: { currentPrice: '150' } })).toBe(0);
    });

    it('returns 0 when input is an array', () => {
        expect(safeAnalysisPrice([{ keyLevels: { currentPrice: 150 } }])).toBe(0);
    });
});

describe('safeAnalysisTrend', () => {
    it('extracts trend from valid structure', () => {
        expect(safeAnalysisTrend({ trend: 'bullish' })).toBe('bullish');
    });

    it('returns undefined for null input', () => {
        expect(safeAnalysisTrend(null)).toBeUndefined();
    });

    it('returns undefined when trend is missing', () => {
        expect(safeAnalysisTrend({})).toBeUndefined();
    });

    it('returns undefined when trend is a number', () => {
        expect(safeAnalysisTrend({ trend: 42 })).toBeUndefined();
    });

    it('returns undefined when trend is null', () => {
        expect(safeAnalysisTrend({ trend: null })).toBeUndefined();
    });

    it('returns undefined when trend is an object', () => {
        expect(safeAnalysisTrend({ trend: { value: 'bullish' } })).toBeUndefined();
    });
});

describe('safeAnalysisSentiment', () => {
    it('extracts overallSentiment from valid structure', () => {
        expect(safeAnalysisSentiment({ overallSentiment: 'bearish' })).toBe('bearish');
    });

    it('returns undefined for null input', () => {
        expect(safeAnalysisSentiment(null)).toBeUndefined();
    });

    it('returns undefined when overallSentiment is missing', () => {
        expect(safeAnalysisSentiment({})).toBeUndefined();
    });

    it('returns undefined when overallSentiment is not a string', () => {
        expect(safeAnalysisSentiment({ overallSentiment: 123 })).toBeUndefined();
    });

    it('returns undefined when overallSentiment is an array', () => {
        expect(safeAnalysisSentiment({ overallSentiment: ['bearish'] })).toBeUndefined();
    });
});

describe('safeAnalysisSupport', () => {
    it('extracts first support level from valid structure', () => {
        expect(safeAnalysisSupport({ keyLevels: { support: [95, 90, 85] } })).toBe(95);
    });

    it('returns undefined for null input', () => {
        expect(safeAnalysisSupport(null)).toBeUndefined();
    });

    it('returns undefined when keyLevels is missing', () => {
        expect(safeAnalysisSupport({})).toBeUndefined();
    });

    it('returns undefined when support is not an array', () => {
        expect(safeAnalysisSupport({ keyLevels: { support: 95 } })).toBeUndefined();
    });

    it('returns undefined when support is an empty array', () => {
        expect(safeAnalysisSupport({ keyLevels: { support: [] } })).toBeUndefined();
    });

    it('returns undefined when support contains only non-numbers', () => {
        expect(safeAnalysisSupport({ keyLevels: { support: ['ninety', null] } })).toBeUndefined();
    });

    it('filters out NaN values in support array', () => {
        expect(safeAnalysisSupport({ keyLevels: { support: [NaN, 90] } })).toBe(90);
    });

    it('returns undefined when keyLevels is an array (not object)', () => {
        expect(safeAnalysisSupport({ keyLevels: [{ support: [95] }] })).toBeUndefined();
    });
});

describe('safeAnalysisResistance', () => {
    it('extracts first resistance level from valid structure', () => {
        expect(safeAnalysisResistance({ keyLevels: { resistance: [110, 120] } })).toBe(110);
    });

    it('returns undefined for null input', () => {
        expect(safeAnalysisResistance(null)).toBeUndefined();
    });

    it('returns undefined when resistance is missing', () => {
        expect(safeAnalysisResistance({ keyLevels: {} })).toBeUndefined();
    });

    it('returns undefined when resistance is not an array', () => {
        expect(safeAnalysisResistance({ keyLevels: { resistance: 'high' } })).toBeUndefined();
    });

    it('returns undefined for nested nulls', () => {
        expect(
            safeAnalysisResistance({ keyLevels: { resistance: [null, undefined] } }),
        ).toBeUndefined();
    });
});

describe('safeAnalysisTargetPrice', () => {
    it('extracts bullish target price from valid structure', () => {
        expect(safeAnalysisTargetPrice({ priceTargets: { bullish: { target: 200 } } })).toBe(200);
    });

    it('returns undefined for null input', () => {
        expect(safeAnalysisTargetPrice(null)).toBeUndefined();
    });

    it('returns undefined when priceTargets is missing', () => {
        expect(safeAnalysisTargetPrice({})).toBeUndefined();
    });

    it('returns undefined when bullish is missing', () => {
        expect(safeAnalysisTargetPrice({ priceTargets: {} })).toBeUndefined();
    });

    it('returns undefined when target is not a positive number', () => {
        expect(
            safeAnalysisTargetPrice({ priceTargets: { bullish: { target: 0 } } }),
        ).toBeUndefined();
    });

    it('returns undefined when target is NaN', () => {
        expect(
            safeAnalysisTargetPrice({ priceTargets: { bullish: { target: NaN } } }),
        ).toBeUndefined();
    });

    it('returns undefined when target is a string', () => {
        expect(
            safeAnalysisTargetPrice({ priceTargets: { bullish: { target: '200' } } }),
        ).toBeUndefined();
    });

    it('returns undefined when priceTargets is an array', () => {
        expect(
            safeAnalysisTargetPrice({ priceTargets: [{ bullish: { target: 200 } }] }),
        ).toBeUndefined();
    });

    it('returns undefined when bullish is an array', () => {
        expect(
            safeAnalysisTargetPrice({ priceTargets: { bullish: [{ target: 200 }] } }),
        ).toBeUndefined();
    });
});

describe('safeActionRecommendation', () => {
    it('extracts valid buy recommendation', () => {
        const result = safeActionRecommendation({
            actionRecommendation: { action: 'buy', confidence: 0.85 },
        });
        expect(result).toEqual({ action: 'buy', confidence: 0.85 });
    });

    it('extracts valid hold recommendation', () => {
        const result = safeActionRecommendation({
            actionRecommendation: { action: 'hold', confidence: 0.5 },
        });
        expect(result).toEqual({ action: 'hold', confidence: 0.5 });
    });

    it('extracts valid wait recommendation', () => {
        const result = safeActionRecommendation({
            actionRecommendation: { action: 'wait', confidence: 0.3 },
        });
        expect(result).toEqual({ action: 'wait', confidence: 0.3 });
    });

    it('returns undefined for null input', () => {
        expect(safeActionRecommendation(null)).toBeUndefined();
    });

    it('returns undefined when actionRecommendation is missing', () => {
        expect(safeActionRecommendation({})).toBeUndefined();
    });

    it('returns undefined when action is not a valid value', () => {
        expect(
            safeActionRecommendation({
                actionRecommendation: { action: 'sell', confidence: 0.9 },
            }),
        ).toBeUndefined();
    });

    it('returns undefined when action is not a string', () => {
        expect(
            safeActionRecommendation({
                actionRecommendation: { action: 42, confidence: 0.9 },
            }),
        ).toBeUndefined();
    });

    it('defaults confidence to 0 when it is not a number', () => {
        const result = safeActionRecommendation({
            actionRecommendation: { action: 'buy', confidence: 'high' },
        });
        expect(result).toEqual({ action: 'buy', confidence: 0 });
    });

    it('defaults confidence to 0 when it is NaN', () => {
        const result = safeActionRecommendation({
            actionRecommendation: { action: 'buy', confidence: NaN },
        });
        expect(result).toEqual({ action: 'buy', confidence: 0 });
    });

    it('returns undefined when actionRecommendation is an array', () => {
        expect(
            safeActionRecommendation({
                actionRecommendation: [{ action: 'buy', confidence: 0.8 }],
            }),
        ).toBeUndefined();
    });
});

describe('safeArray', () => {
    it('extracts array from valid key', () => {
        expect(safeArray({ signals: [1, 2, 3] }, 'signals')).toEqual([1, 2, 3]);
    });

    it('returns undefined for null input', () => {
        expect(safeArray(null, 'signals')).toBeUndefined();
    });

    it('returns undefined when key does not exist', () => {
        expect(safeArray({}, 'signals')).toBeUndefined();
    });

    it('returns undefined when value is not an array', () => {
        expect(safeArray({ signals: 'not-array' }, 'signals')).toBeUndefined();
    });

    it('returns empty array when value is empty array', () => {
        expect(safeArray({ signals: [] }, 'signals')).toEqual([]);
    });
});

describe('safeNumberArray', () => {
    it('filters out non-number values', () => {
        expect(safeNumberArray([1, 'two', 3, null, 4])).toEqual([1, 3, 4]);
    });

    it('filters out NaN and Infinity', () => {
        expect(safeNumberArray([NaN, Infinity, -Infinity, 5])).toEqual([5]);
    });

    it('returns undefined for non-array', () => {
        expect(safeNumberArray('not-array')).toBeUndefined();
    });

    it('returns undefined for null', () => {
        expect(safeNumberArray(null)).toBeUndefined();
    });

    it('returns undefined for empty array after filtering', () => {
        expect(safeNumberArray([NaN, 'string', null])).toBeUndefined();
    });

    it('returns valid numbers from mixed array', () => {
        expect(safeNumberArray([0, -5, 10])).toEqual([0, -5, 10]);
    });
});

describe('safeString', () => {
    it('returns string when input is string', () => {
        expect(safeString('hello')).toBe('hello');
    });

    it('returns undefined for numbers', () => {
        expect(safeString(42)).toBeUndefined();
    });

    it('returns undefined for null', () => {
        expect(safeString(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(safeString(undefined)).toBeUndefined();
    });

    it('returns undefined for objects', () => {
        expect(safeString({ toString: () => 'hello' })).toBeUndefined();
    });

    it('returns empty string for empty string input', () => {
        expect(safeString('')).toBe('');
    });
});
