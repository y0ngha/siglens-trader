import { describe, it, expect } from 'vitest';
import {
    DEFAULT_ENTRY_WINDOW,
    ENTRY_WINDOW_ALL_DAY,
    formatEntryWindow,
    isWithinEntryWindow,
    parseEntryWindow,
    parseTimeOfDay,
} from '../entry-window';

describe('parseTimeOfDay', () => {
    it('converts HH:MM to minutes from midnight', () => {
        expect(parseTimeOfDay('00:00')).toBe(0);
        expect(parseTimeOfDay('09:30')).toBe(570);
        expect(parseTimeOfDay('11:00')).toBe(660);
        expect(parseTimeOfDay('23:59')).toBe(1439);
    });

    it('accepts 24:00 as the end of the day', () => {
        expect(parseTimeOfDay('24:00')).toBe(1440);
    });

    it('rejects out-of-range and malformed values', () => {
        for (const bad of ['24:01', '25:00', '11:60', '99:99', 'abc', '11', '1:00', '', '11:0']) {
            expect(parseTimeOfDay(bad)).toBeNull();
        }
    });

    it('rejects non-string input', () => {
        for (const bad of [null, undefined, 660, {}, [], true]) {
            expect(parseTimeOfDay(bad)).toBeNull();
        }
    });
});

describe('parseEntryWindow', () => {
    it('parses a well-formed window', () => {
        expect(parseEntryWindow({ start: '11:00', end: '15:00' })).toEqual({
            startMinute: 660,
            endMinute: 900,
        });
    });

    it('keeps minute-level precision', () => {
        expect(parseEntryWindow({ start: '09:30', end: '15:45' })).toEqual({
            startMinute: 570,
            endMinute: 945,
        });
    });

    it('accepts 24:00 as the end (all-day = feature off)', () => {
        expect(parseEntryWindow({ start: '00:00', end: '24:00' })).toEqual(ENTRY_WINDOW_ALL_DAY);
    });

    it('falls back to the default for non-object input', () => {
        for (const bad of [null, undefined, 'a', 42, [], true]) {
            expect(parseEntryWindow(bad)).toEqual(DEFAULT_ENTRY_WINDOW);
        }
    });

    it('falls back to the default when a field is missing', () => {
        expect(parseEntryWindow({ start: '11:00' })).toEqual(DEFAULT_ENTRY_WINDOW);
        expect(parseEntryWindow({ end: '15:00' })).toEqual(DEFAULT_ENTRY_WINDOW);
        expect(parseEntryWindow({})).toEqual(DEFAULT_ENTRY_WINDOW);
    });

    it('falls back to the default for malformed times', () => {
        for (const bad of [
            { start: '25:00', end: '15:00' },
            { start: '11:00', end: '11:60' },
            { start: 'abc', end: '15:00' },
            { start: '11', end: '15' },
            { start: '', end: '' },
            { start: 660, end: 900 },
        ]) {
            expect(parseEntryWindow(bad)).toEqual(DEFAULT_ENTRY_WINDOW);
        }
    });

    it('falls back to the default when start >= end (no midnight wrap)', () => {
        expect(parseEntryWindow({ start: '11:00', end: '11:00' })).toEqual(DEFAULT_ENTRY_WINDOW);
        expect(parseEntryWindow({ start: '15:00', end: '11:00' })).toEqual(DEFAULT_ENTRY_WINDOW);
    });
});

describe('formatEntryWindow', () => {
    it('round-trips the default window', () => {
        expect(formatEntryWindow(DEFAULT_ENTRY_WINDOW)).toEqual({ start: '11:00', end: '15:00' });
    });

    it('zero-pads single-digit hours and minutes', () => {
        expect(formatEntryWindow({ startMinute: 570, endMinute: 605 })).toEqual({
            start: '09:30',
            end: '10:05',
        });
        expect(formatEntryWindow({ startMinute: 0, endMinute: 5 })).toEqual({
            start: '00:00',
            end: '00:05',
        });
    });

    it('renders the end of the day as 24:00', () => {
        expect(formatEntryWindow(ENTRY_WINDOW_ALL_DAY)).toEqual({ start: '00:00', end: '24:00' });
    });
});

describe('isWithinEntryWindow', () => {
    const w = DEFAULT_ENTRY_WINDOW; // ET 11:00–15:00

    it('accepts a time inside the window', () => {
        // 2026-07-15T17:00Z = 13:00 EDT
        expect(isWithinEntryWindow(new Date('2026-07-15T17:00:00Z'), w)).toBe(true);
    });

    it('includes the start boundary and excludes the end boundary', () => {
        // 15:00Z = 11:00 EDT (포함), 19:00Z = 15:00 EDT (배타)
        expect(isWithinEntryWindow(new Date('2026-07-15T15:00:00Z'), w)).toBe(true);
        expect(isWithinEntryWindow(new Date('2026-07-15T18:59:00Z'), w)).toBe(true);
        expect(isWithinEntryWindow(new Date('2026-07-15T19:00:00Z'), w)).toBe(false);
    });

    it('rejects a time outside the window', () => {
        // 14:59Z = 10:59 EDT
        expect(isWithinEntryWindow(new Date('2026-07-15T14:59:00Z'), w)).toBe(false);
        // 20:00Z = 16:00 EDT
        expect(isWithinEntryWindow(new Date('2026-07-15T20:00:00Z'), w)).toBe(false);
    });

    // 이 파일이 존재하는 이유: 같은 UTC 시각이 서머타임 양쪽에서 다른 ET가 된다.
    it('resolves the same UTC instant differently across DST', () => {
        // 여름(EDT, UTC-4): 15:00Z → 11:00 ET → 창 안
        expect(isWithinEntryWindow(new Date('2026-07-15T15:00:00Z'), w)).toBe(true);
        // 겨울(EST, UTC-5): 15:00Z → 10:00 ET → 창 밖
        expect(isWithinEntryWindow(new Date('2026-01-15T15:00:00Z'), w)).toBe(false);
        // 겨울에 창 안이 되려면 한 시간 늦어야 한다: 16:00Z → 11:00 ET
        expect(isWithinEntryWindow(new Date('2026-01-15T16:00:00Z'), w)).toBe(true);
    });

    it('blocks entry when the clock cannot be read (fail-closed)', () => {
        expect(isWithinEntryWindow(new Date('invalid'), w)).toBe(false);
        expect(isWithinEntryWindow(new Date(NaN), w)).toBe(false);
    });

    it('accepts every instant when the window is all-day', () => {
        // 04:00Z = 00:00 EDT, 03:59Z = 23:59 EDT (같은 날 자정/직전)
        expect(isWithinEntryWindow(new Date('2026-07-15T04:00:00Z'), ENTRY_WINDOW_ALL_DAY)).toBe(
            true,
        );
        expect(isWithinEntryWindow(new Date('2026-07-15T03:59:00Z'), ENTRY_WINDOW_ALL_DAY)).toBe(
            true,
        );
        expect(isWithinEntryWindow(new Date('2026-01-15T15:00:00Z'), ENTRY_WINDOW_ALL_DAY)).toBe(
            true,
        );
    });
});
