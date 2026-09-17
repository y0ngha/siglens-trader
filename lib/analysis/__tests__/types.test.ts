import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_ANALYSIS_REASONING, getAnalysisReasoning, symbolSignal, toErrStr } from '../types';

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
    it('전 축 추론 OFF (2026-09-17 운영자 결정)', () => {
        for (const t of ['technical', 'options', 'news', 'fundamental', 'congress', 'unknown']) {
            expect(getAnalysisReasoning(t)).toBe(false);
        }
        expect(DEFAULT_ANALYSIS_REASONING).toBe(false);
    });

    describe('symbolSignal', () => {
        it('마감이 없으면 signal도 없다 — 심볼당 상한을 두지 않는다', () => {
            // 150초 상한은 추론 ON 축에서 타임아웃이 아니라 실패 그 자체였다: 우리가 끊은
            // 응답이 finish_reason 없이 돌아와 core에서 AI_SERVER_UNSTABLE이 됐다.
            expect(symbolSignal(undefined)).toBeUndefined();
            expect(symbolSignal(Number.POSITIVE_INFINITY)).toBeUndefined();
        });

        it('마감이 있으면 그 시각까지가 예산이다', () => {
            vi.useFakeTimers();
            try {
                const signal = symbolSignal(Date.now() + 600_000)!;
                expect(signal.aborted).toBe(false);
                // 종전 상한(150초)에서는 이미 끊겼을 시점
                vi.advanceTimersByTime(300_000);
                expect(signal.aborted).toBe(false);
                vi.advanceTimersByTime(300_001);
                expect(signal.aborted).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('이미 마감을 넘겼어도 즉시 중단시키지 않는다 — 0은 무의미한 실패로 기록된다', () => {
            vi.useFakeTimers();
            try {
                const signal = symbolSignal(Date.now() - 60_000)!;
                expect(signal.aborted).toBe(false);
                vi.advanceTimersByTime(2);
                expect(signal.aborted).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('falls back to the default for an unpolicied type', () => {
        expect(getAnalysisReasoning('brand-new-analysis')).toBe(DEFAULT_ANALYSIS_REASONING);
    });
});
