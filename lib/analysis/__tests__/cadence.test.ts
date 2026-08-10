import { describe, expect, it } from 'vitest';
import { getMinIntervalMs } from '../cadence';

// The guard enforces slightly less than the nominal interval so a tick on the intended
// schedule is not rejected by the processing latency of the tick before it (see
// SCHEDULE_JITTER_TOLERANCE). Assertions below use the enforced value.
const MIN = 60_000;
const enforced = (nominalMs: number) => Math.round(nominalMs * 0.9);

describe('getMinIntervalMs', () => {
    // Horizon-sensitive types: cadence tracks bar duration
    it.each([
        ['technical', '15Min', 15 * MIN],
        ['technical', '30Min', 30 * MIN],
        ['technical', '1Hour', 60 * MIN],
        ['options', '15Min', 15 * MIN],
        ['options', '30Min', 30 * MIN],
        ['options', '1Hour', 60 * MIN],
    ] as const)('%s @ %s tracks the %d ms bar duration', (analysisType, timeframe, nominal) => {
        expect(getMinIntervalMs(analysisType, timeframe)).toBe(enforced(nominal));
    });

    // Fixed-spacing types: timeframe does not affect the result
    it.each(['15Min', '30Min', '1Hour'] as const)(
        'news is hourly regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('news', tf)).toBe(enforced(60 * MIN));
        },
    );

    it.each(['15Min', '30Min', '1Hour'] as const)(
        'fundamental is daily regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('fundamental', tf)).toBe(enforced(24 * 60 * MIN));
        },
    );

    it.each(['15Min', '30Min', '1Hour'] as const)(
        'congress is daily regardless of timeframe %s',
        (tf) => {
            expect(getMinIntervalMs('congress', tf)).toBe(enforced(24 * 60 * MIN));
        },
    );

    it('unknown type returns 0 (never skipped)', () => {
        expect(getMinIntervalMs('unknown-type', '1Hour')).toBe(0);
        expect(getMinIntervalMs('', '15Min')).toBe(0);
    });

    describe('a tick on the intended schedule is never rejected by its own latency', () => {
        // Regression guard. An analysis is stamped when saved, which is later than the tick
        // that started it, so the gap to the next same-cadence tick measures a little under
        // the nominal interval. Enforcing the full interval turned the daily analyses into
        // every-other-day ones and the hourly news analysis into an every-other-hour one.
        const LLM_LATENCY = 90_000; // observed: deepseek-v4-pro runs 20-45s per symbol

        it.each([
            ['news', '1Hour', 60 * MIN],
            ['fundamental', '1Hour', 24 * 60 * MIN],
            ['congress', '1Hour', 24 * 60 * MIN],
            ['technical', '15Min', 15 * MIN],
            ['technical', '1Hour', 60 * MIN],
            ['options', '30Min', 30 * MIN],
        ] as const)('%s @ %s admits the next scheduled tick', (type, tf, nominal) => {
            const elapsedAtNextTick = nominal - LLM_LATENCY;
            expect(getMinIntervalMs(type, tf)).toBeLessThanOrEqual(elapsedAtNextTick);
        });

        it('still rejects a surplus tick from the tighter schedule', () => {
            // technical fires every 15 min; on a 1Hour horizon the in-between ticks must skip.
            expect(getMinIntervalMs('technical', '1Hour')).toBeGreaterThan(15 * MIN);
            expect(getMinIntervalMs('technical', '1Hour')).toBeGreaterThan(45 * MIN);
        });
    });
});
