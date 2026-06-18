import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_TIMEFRAMES,
    DEFAULT_ANALYSIS_TIMEFRAME,
    getTechnicalMaxAgeMs,
    isAnalysisTimeframe,
    normalizeAnalysisTimeframe,
    toCoreTimeframe,
} from '../timeframe';

describe('analysis timeframe contract', () => {
    it('supports only 15m, 30m, and 1h', () => {
        expect(ANALYSIS_TIMEFRAMES).toEqual(['15Min', '30Min', '1Hour']);
        expect(DEFAULT_ANALYSIS_TIMEFRAME).toBe('1Hour');
    });

    it.each(['15Min', '30Min', '1Hour'] as const)(
        'recognizes supported timeframe %s',
        (timeframe) => {
            expect(isAnalysisTimeframe(timeframe)).toBe(true);
        },
    );

    it.each([null, undefined, '5Min', '4Hour', '1Day', 'arbitrary', 60])(
        'rejects unsupported timeframe %s',
        (timeframe) => {
            expect(isAnalysisTimeframe(timeframe)).toBe(false);
        },
    );

    it('falls back to 1Hour for missing or legacy values', () => {
        expect(normalizeAnalysisTimeframe(null)).toBe('1Hour');
        expect(normalizeAnalysisTimeframe('1Day')).toBe('1Hour');
    });

    it('preserves supported values when converting to the core timeframe', () => {
        expect(toCoreTimeframe('15Min')).toBe('15Min');
        expect(toCoreTimeframe('30Min')).toBe('30Min');
        expect(toCoreTimeframe('1Hour')).toBe('1Hour');
        expect(toCoreTimeframe('4Hour')).toBe('1Hour');
    });

    it.each([
        ['15Min', 45 * 60_000],
        ['30Min', 90 * 60_000],
        ['1Hour', 2 * 60 * 60_000],
    ] as const)('maps %s to its max age', (timeframe, expected) => {
        expect(getTechnicalMaxAgeMs(timeframe)).toBe(expected);
    });
});
