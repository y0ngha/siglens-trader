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
    it('technical은 추론을 켠다 — 주기 저하가 매매를 멈추지 않기 때문', () => {
        // 2026-08-10 측정에서 심볼당 ~7분이 나와 껐지만, 그 결론("신호가 사라진다")이
        // 과장이었다. 패스가 창(30분)을 넘겨도 마지막 종목의 갱신이 30→60분이 될 뿐이고,
        // 60분은 30Min 신선도 한도(90분) 안이라 매매는 계속 돈다.
        expect(getAnalysisReasoning('technical')).toBe(true);
    });

    it('options도 추론을 켠다 (2026-08-17)', () => {
        // 축 하나만 꺼 두면 "왜 이 축만 다른가"를 매번 설명해야 하고, 실제로 판단 근거의
        // 두께가 얇아진다. 상한이 추론 정책을 따라오므로(getPerSymbolMaxMs) 켜는 비용은
        // 시간뿐이고, 케이던스 창이 잉여 틱을 접는다.
        expect(getAnalysisReasoning('options')).toBe(true);
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
