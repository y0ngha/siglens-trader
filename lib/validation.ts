/**
 * Shared validation utilities for runtime input sanitization and NaN protection.
 *
 * These guards exist because AI analysis results arrive as untyped JSON (`as any`),
 * user-controlled inputs (quantity, price) pass through API boundaries without
 * schema validation, and division-by-zero (avgPrice=0) can silently propagate NaN
 * through the entire trading pipeline.
 */

/** Returns true when `value` is a finite number greater than zero. */
export function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Returns true when `value` is a finite number greater than or equal to zero. */
export function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Coerces `value` to a finite number, returning `fallback` when the input
 * is not a number or is NaN/Infinity.
 */
export function safeNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return fallback;
}
