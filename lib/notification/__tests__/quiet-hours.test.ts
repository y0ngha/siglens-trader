import { describe, it, expect } from 'vitest';
import { isQuietHours, QUIET_HOURS_START, QUIET_HOURS_END } from '../quiet-hours';

/**
 * UTC→Seoul (KST = UTC+9) reference table used for the test cases below.
 *
 * 15:00 UTC  = 00:00 KST (midnight)           → quiet
 * 23:59 UTC  = 08:59 KST                      → quiet
 * 00:00 UTC  = 09:00 KST (boundary, last quiet hour) → quiet
 * 01:00 UTC  = 10:00 KST (first non-quiet hour)       → NOT quiet
 * 06:00 UTC  = 15:00 KST (mid-afternoon)      → NOT quiet
 */

describe('isQuietHours', () => {
    it('exports expected window bounds', () => {
        expect(QUIET_HOURS_START).toBe(0);
        expect(QUIET_HOURS_END).toBe(9);
    });

    it('15:00 UTC → 00:00 KST (midnight) — quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T15:00:00.000Z'))).toBe(true);
    });

    it('15:30 UTC → 00:30 KST — quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T15:30:00.000Z'))).toBe(true);
    });

    it('23:59 UTC → 08:59 KST — quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T23:59:00.000Z'))).toBe(true);
    });

    it('00:00 UTC → 09:00 KST (last quiet hour boundary) — quiet', () => {
        // Hour 9 is the last hour in the quiet window (inclusive).
        expect(isQuietHours(new Date('2026-08-11T00:00:00.000Z'))).toBe(true);
    });

    it('00:59 UTC → 09:59 KST (still within hour 9) — quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T00:59:59.000Z'))).toBe(true);
    });

    it('01:00 UTC → 10:00 KST (first non-quiet hour) — NOT quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T01:00:00.000Z'))).toBe(false);
    });

    it('06:00 UTC → 15:00 KST — NOT quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T06:00:00.000Z'))).toBe(false);
    });

    it('14:00 UTC → 23:00 KST (late evening Seoul) — NOT quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T14:00:00.000Z'))).toBe(false);
    });

    it('14:59 UTC → 23:59 KST — NOT quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T14:59:00.000Z'))).toBe(false);
    });
});
