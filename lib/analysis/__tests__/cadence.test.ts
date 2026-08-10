import { describe, expect, it } from 'vitest';
import { getCadenceWindowMs, isWithinCadenceWindow } from '../cadence';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('getCadenceWindowMs', () => {
    // Horizon-sensitive types track the configured bar duration
    it.each([
        ['technical', '15Min', 15 * MIN],
        ['technical', '30Min', 30 * MIN],
        ['technical', '1Hour', HOUR],
        ['options', '15Min', 15 * MIN],
        ['options', '30Min', 30 * MIN],
        ['options', '1Hour', HOUR],
    ] as const)('%s @ %s → %d ms', (analysisType, timeframe, expected) => {
        expect(getCadenceWindowMs(analysisType, timeframe)).toBe(expected);
    });

    // Fixed-spacing types ignore the timeframe
    it.each(['15Min', '30Min', '1Hour'] as const)('news is hourly @ %s', (tf) => {
        expect(getCadenceWindowMs('news', tf)).toBe(HOUR);
    });

    it.each(['15Min', '30Min', '1Hour'] as const)('fundamental is daily @ %s', (tf) => {
        expect(getCadenceWindowMs('fundamental', tf)).toBe(24 * HOUR);
    });

    it.each(['15Min', '30Min', '1Hour'] as const)('congress is daily @ %s', (tf) => {
        expect(getCadenceWindowMs('congress', tf)).toBe(24 * HOUR);
    });

    it('unknown type returns 0 (never skipped)', () => {
        expect(getCadenceWindowMs('unknown-type', '1Hour')).toBe(0);
        expect(getCadenceWindowMs('', '15Min')).toBe(0);
    });
});

describe('isWithinCadenceWindow', () => {
    const at = (iso: string) => new Date(iso).getTime();

    it('treats the same clock window as covered', () => {
        expect(
            isWithinCadenceWindow(at('2026-08-10T15:02:00Z'), at('2026-08-10T15:15:00Z'), 30 * MIN),
        ).toBe(true);
    });

    it('treats the next clock window as due', () => {
        expect(
            isWithinCadenceWindow(at('2026-08-10T15:02:00Z'), at('2026-08-10T15:30:00Z'), 30 * MIN),
        ).toBe(false);
    });

    it('is immune to how long the previous analysis took', () => {
        // Regression guard. The old elapsed-time rule measured from the SAVE stamp, so a
        // 5-minute analysis starting at :00 was stamped :05 and the :30 tick saw only 25
        // minutes elapsed — it skipped, and the real cadence silently became 45 minutes.
        const savedAfterSlowRun = at('2026-08-10T15:05:00Z');
        const nextScheduledTick = at('2026-08-10T15:30:00Z');
        expect(isWithinCadenceWindow(savedAfterSlowRun, nextScheduledTick, 30 * MIN)).toBe(false);
    });

    it('still collapses a surplus tick from a tighter schedule', () => {
        // 15-minute cron tick against a 30-minute window: same window → skipped.
        expect(
            isWithinCadenceWindow(at('2026-08-10T15:31:00Z'), at('2026-08-10T15:45:00Z'), 30 * MIN),
        ).toBe(true);
    });

    it('gives a daily analysis one run per UTC day regardless of latency', () => {
        const yesterday = at('2026-08-10T15:00:50Z');
        expect(isWithinCadenceWindow(yesterday, at('2026-08-10T16:00:00Z'), 24 * HOUR)).toBe(true);
        expect(isWithinCadenceWindow(yesterday, at('2026-08-11T15:00:00Z'), 24 * HOUR)).toBe(false);
    });

    it('gives an hourly analysis one run per clock hour regardless of latency', () => {
        const saved = at('2026-08-10T15:01:35Z');
        expect(isWithinCadenceWindow(saved, at('2026-08-10T15:59:00Z'), HOUR)).toBe(true);
        expect(isWithinCadenceWindow(saved, at('2026-08-10T16:00:00Z'), HOUR)).toBe(false);
    });

    it('never skips when there is no policy (window 0)', () => {
        expect(
            isWithinCadenceWindow(at('2026-08-10T15:00:00Z'), at('2026-08-10T15:00:01Z'), 0),
        ).toBe(false);
    });
});
