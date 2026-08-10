import { describe, expect, it } from 'vitest';
import { getMinIntervalMs } from '../cadence';

describe('getMinIntervalMs', () => {
    // Horizon-sensitive types: cadence matches bar duration
    it.each([
        ['technical', '15Min', 15 * 60_000],
        ['technical', '30Min', 30 * 60_000],
        ['technical', '1Hour', 60 * 60_000],
        ['options', '15Min', 15 * 60_000],
        ['options', '30Min', 30 * 60_000],
        ['options', '1Hour', 60 * 60_000],
    ] as const)('%s @ %s → %d ms (bar duration)', (analysisType, timeframe, expected) => {
        expect(getMinIntervalMs(analysisType, timeframe)).toBe(expected);
    });

    // Fixed-spacing types: timeframe does not affect the result
    it.each(['15Min', '30Min', '1Hour'] as const)(
        'news returns 60 min regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('news', tf)).toBe(60 * 60_000);
        },
    );

    it.each(['15Min', '30Min', '1Hour'] as const)(
        'fundamental returns 24 h regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('fundamental', tf)).toBe(24 * 60 * 60_000);
        },
    );

    it.each(['15Min', '30Min', '1Hour'] as const)(
        'congress returns 24 h regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('congress', tf)).toBe(24 * 60 * 60_000);
        },
    );

    it('unknown type returns 0 (never skipped)', () => {
        expect(getMinIntervalMs('unknown-type', '1Hour')).toBe(0);
        expect(getMinIntervalMs('', '15Min')).toBe(0);
    });
});
