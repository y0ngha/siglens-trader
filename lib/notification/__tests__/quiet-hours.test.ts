import { describe, it, expect } from 'vitest';
import {
    isQuietHours,
    parseDigestHour,
    DEFAULT_DIGEST_HOUR,
    seoulDate,
    seoulDayStart,
} from '../quiet-hours';

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
    it('defaults to a 10:00 KST digest', () => {
        expect(DEFAULT_DIGEST_HOUR).toBe(10);
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

describe('isQuietHours with a configured digest hour', () => {
    it('digest 07 → 06:59 KST is quiet, 07:00 KST is not', () => {
        expect(isQuietHours(new Date('2026-08-11T21:59:00.000Z'), 7)).toBe(true);
        expect(isQuietHours(new Date('2026-08-11T22:00:00.000Z'), 7)).toBe(false);
    });

    it('digest 12 → 11:30 KST is quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T02:30:00.000Z'), 12)).toBe(true);
    });

    it('the window always starts at 00:00 KST — 23:30 KST is never quiet', () => {
        expect(isQuietHours(new Date('2026-08-11T14:30:00.000Z'), 23)).toBe(false);
    });
});

describe('parseDigestHour', () => {
    it('passes integers in 1..23 through', () => {
        expect(parseDigestHour(1)).toBe(1);
        expect(parseDigestHour(7)).toBe(7);
        expect(parseDigestHour(23)).toBe(23);
    });

    it('worst: missing, out-of-range, fractional or non-number → default 10', () => {
        for (const bad of [null, undefined, 0, 24, -1, 7.5, '7', NaN]) {
            expect(parseDigestHour(bad)).toBe(10);
        }
    });
});

describe('seoulDate / seoulDayStart', () => {
    it('rolls over at 00:00 KST (15:00 UTC), not at UTC midnight', () => {
        expect(seoulDate(new Date('2026-08-11T14:59:59.000Z'))).toBe('2026-08-11');
        expect(seoulDate(new Date('2026-08-11T15:00:00.000Z'))).toBe('2026-08-12');
    });

    it('day start is 00:00 KST of that Seoul day', () => {
        expect(seoulDayStart(new Date('2026-08-11T22:00:00.000Z')).toISOString()).toBe(
            '2026-08-11T15:00:00.000Z',
        );
    });
});
