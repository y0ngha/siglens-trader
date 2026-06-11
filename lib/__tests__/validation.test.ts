import { describe, it, expect } from 'vitest';
import { isFinitePositive, isFiniteNonNegative, safeNumber, parseDecimal } from '../validation';

describe('isFinitePositive', () => {
    it('returns true for positive finite numbers', () => {
        expect(isFinitePositive(1)).toBe(true);
        expect(isFinitePositive(0.001)).toBe(true);
        expect(isFinitePositive(999_999)).toBe(true);
    });

    it('returns false for zero', () => {
        expect(isFinitePositive(0)).toBe(false);
    });

    it('returns false for negative numbers', () => {
        expect(isFinitePositive(-1)).toBe(false);
        expect(isFinitePositive(-0.001)).toBe(false);
    });

    it('returns false for NaN', () => {
        expect(isFinitePositive(NaN)).toBe(false);
    });

    it('returns false for Infinity', () => {
        expect(isFinitePositive(Infinity)).toBe(false);
        expect(isFinitePositive(-Infinity)).toBe(false);
    });

    it('returns false for non-number types', () => {
        expect(isFinitePositive('5')).toBe(false);
        expect(isFinitePositive(null)).toBe(false);
        expect(isFinitePositive(undefined)).toBe(false);
        expect(isFinitePositive({})).toBe(false);
        expect(isFinitePositive(true)).toBe(false);
    });
});

describe('isFiniteNonNegative', () => {
    it('returns true for positive finite numbers', () => {
        expect(isFiniteNonNegative(1)).toBe(true);
        expect(isFiniteNonNegative(0.001)).toBe(true);
    });

    it('returns true for zero', () => {
        expect(isFiniteNonNegative(0)).toBe(true);
    });

    it('returns false for negative numbers', () => {
        expect(isFiniteNonNegative(-1)).toBe(false);
        expect(isFiniteNonNegative(-0.001)).toBe(false);
    });

    it('returns false for NaN', () => {
        expect(isFiniteNonNegative(NaN)).toBe(false);
    });

    it('returns false for Infinity', () => {
        expect(isFiniteNonNegative(Infinity)).toBe(false);
        expect(isFiniteNonNegative(-Infinity)).toBe(false);
    });

    it('returns false for non-number types', () => {
        expect(isFiniteNonNegative('0')).toBe(false);
        expect(isFiniteNonNegative(null)).toBe(false);
        expect(isFiniteNonNegative(undefined)).toBe(false);
    });
});

describe('safeNumber', () => {
    it('returns the value when it is a finite number', () => {
        expect(safeNumber(42, 0)).toBe(42);
        expect(safeNumber(-5, 0)).toBe(-5);
        expect(safeNumber(0, 99)).toBe(0);
        expect(safeNumber(3.14, 0)).toBe(3.14);
    });

    it('returns fallback for NaN', () => {
        expect(safeNumber(NaN, 0)).toBe(0);
        expect(safeNumber(NaN, 99)).toBe(99);
    });

    it('returns fallback for Infinity', () => {
        expect(safeNumber(Infinity, 0)).toBe(0);
        expect(safeNumber(-Infinity, 0)).toBe(0);
    });

    it('returns fallback for non-number types', () => {
        expect(safeNumber('42', 0)).toBe(0);
        expect(safeNumber(null, -1)).toBe(-1);
        expect(safeNumber(undefined, 5)).toBe(5);
        expect(safeNumber({}, 10)).toBe(10);
    });
});

describe('parseDecimal', () => {
    it('parses decimal string correctly', () => {
        expect(parseDecimal('0.013315', 0)).toBe(0.013315);
        expect(parseDecimal('43.404581', 0)).toBe(43.404581);
    });

    it('passes through number values', () => {
        expect(parseDecimal(5, 0)).toBe(5);
    });

    it('returns fallback for unparseable string', () => {
        expect(parseDecimal('abc', 0)).toBe(0);
    });

    it('returns fallback for empty string', () => {
        expect(parseDecimal('', 0)).toBe(0);
    });

    it('returns fallback for undefined', () => {
        expect(parseDecimal(undefined, 0)).toBe(0);
    });

    it('returns fallback for null', () => {
        expect(parseDecimal(null, 0)).toBe(0);
    });

    it('returns fallback for Infinity string (parseFloat→Infinity, not finite)', () => {
        expect(parseDecimal('Infinity', 0)).toBe(0);
    });
});
