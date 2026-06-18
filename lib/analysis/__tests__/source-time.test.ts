import { describe, expect, it } from 'vitest';
import { extractSourceAnalyzedAt, getAnalysisReferenceTime } from '../source-time';

describe('source analysis time', () => {
    it('extracts a valid result analyzedAt', () => {
        expect(
            extractSourceAnalyzedAt({ analyzedAt: '2026-06-17T14:03:03.109Z' })?.toISOString(),
        ).toBe('2026-06-17T14:03:03.109Z');
    });

    it('returns the fallback for missing or invalid values', () => {
        const fallback = new Date('2026-06-17T15:00:00Z');

        expect(extractSourceAnalyzedAt({}, fallback)).toBe(fallback);
        expect(extractSourceAnalyzedAt({ analyzedAt: 'bad' }, fallback)).toBe(fallback);
        expect(extractSourceAnalyzedAt(null, fallback)).toBe(fallback);
    });

    it.each(['06/17/2026', '0', '2026-06-17T14:03:03', '2026-02-30T00:00:00Z'])(
        'rejects non-strict or invalid instant %s',
        (analyzedAt) => {
            const fallback = new Date('2026-06-17T15:00:00Z');

            expect(extractSourceAnalyzedAt({ analyzedAt }, fallback)).toBe(fallback);
        },
    );

    it('accepts a valid instant with an explicit numeric timezone', () => {
        expect(
            extractSourceAnalyzedAt({
                analyzedAt: '2026-06-17T23:03:03.109+09:00',
            })?.toISOString(),
        ).toBe('2026-06-17T14:03:03.109Z');
    });

    it('prefers a valid sourceAnalyzedAt over analyzedAt', () => {
        expect(
            getAnalysisReferenceTime({
                sourceAnalyzedAt: new Date('2026-06-17T14:00:00Z'),
                analyzedAt: new Date('2026-06-17T15:00:00Z'),
            }).toISOString(),
        ).toBe('2026-06-17T14:00:00.000Z');
    });

    it('falls back to analyzedAt when sourceAnalyzedAt is missing or invalid', () => {
        const analyzedAt = new Date('2026-06-17T15:00:00Z');

        expect(
            getAnalysisReferenceTime({
                sourceAnalyzedAt: null,
                analyzedAt,
            }),
        ).toEqual(analyzedAt);
        expect(
            getAnalysisReferenceTime({
                sourceAnalyzedAt: 'bad',
                analyzedAt,
            }),
        ).toEqual(analyzedAt);
    });
});
