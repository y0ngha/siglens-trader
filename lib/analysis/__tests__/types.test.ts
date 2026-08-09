import { describe, it, expect } from 'vitest';
import { toErrStr } from '../types';

describe('toErrStr', () => {
    it('plain string → 그대로 반환', () => {
        expect(toErrStr('something went wrong')).toBe('something went wrong');
    });

    it('Error instance → .message 반환', () => {
        expect(toErrStr(new Error('network failure'))).toBe('network failure');
    });

    it('object-with-message (core structured errors: AnalysisLimitError 등) → .message 반환', () => {
        const coreError = {
            code: 'analysis_limit_exceeded',
            message: 'Daily limit exceeded',
            feature: 'analysisPerDay',
            tier: 'pro',
        };
        expect(toErrStr(coreError)).toBe('Daily limit exceeded');
    });

    it('plain object without message → JSON.stringify 폴백', () => {
        const result = toErrStr({ code: 'unknown', detail: 42 });
        expect(result).toBe('{"code":"unknown","detail":42}');
    });

    it('undefined → JSON.stringify undefined === undefined이므로 String() 폴백', () => {
        // JSON.stringify(undefined) returns undefined → ?? String(undefined) → 'undefined'
        expect(toErrStr(undefined)).toBe('undefined');
    });

    it('null → JSON.stringify(null) === "null"', () => {
        expect(toErrStr(null)).toBe('null');
    });

    it('number → JSON.stringify 폴백', () => {
        expect(toErrStr(42)).toBe('42');
    });
});
