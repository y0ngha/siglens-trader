import { describe, it, expect } from 'vitest';
import { DEFAULT_ANALYSIS_REASONING, getAnalysisReasoning, toErrStr } from '../types';

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

describe('getAnalysisReasoning', () => {
    it('technical은 추론을 켠다 — 주기 저하가 매매를 멈추지 않기 때문', () => {
        // 2026-08-10 측정에서 심볼당 ~7분이 나와 껐지만, 그 결론("신호가 사라진다")이
        // 과장이었다. 패스가 창(30분)을 넘겨도 마지막 종목의 갱신이 30→60분이 될 뿐이고,
        // 60분은 30Min 신선도 한도(90분) 안이라 매매는 계속 돈다.
        expect(getAnalysisReasoning('technical')).toBe(true);
    });

    it('options는 추론을 끈 채로 둔다', () => {
        // 옵션 체인 요약은 만기별 OI/IV 집계라 장문 추론이 결론을 바꾸기 어렵고,
        // 한 번에 둘 다 바꾸면 어느 쪽이 원인인지 가릴 수 없다.
        expect(getAnalysisReasoning('options')).toBe(false);
    });

    it('keeps reasoning on where latency is affordable', () => {
        expect(getAnalysisReasoning('news')).toBe(true);
        expect(getAnalysisReasoning('fundamental')).toBe(true);
        expect(getAnalysisReasoning('congress')).toBe(true);
    });

    it('falls back to the default for an unpolicied type', () => {
        expect(getAnalysisReasoning('brand-new-analysis')).toBe(DEFAULT_ANALYSIS_REASONING);
    });
});
