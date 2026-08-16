import { describe, it, expect } from 'vitest';
import {
    DEFAULT_EXECUTE_INTERVAL_MIN,
    EXECUTE_BASE_MINUTE,
    EXECUTE_INTERVALS,
    isExecuteInterval,
    hasTickInWindow,
    isExecuteTick,
    parseExecuteInterval,
} from '../execute-interval.js';

/** cron `7-59/5`가 실제로 부르는 분들. 게이트는 이 집합에서만 판정된다. */
const CRON_MINUTES = [7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57];

function at(minute: number): Date {
    return new Date(Date.UTC(2026, 7, 17, 15, minute, 0));
}

function firingMinutes(interval: (typeof EXECUTE_INTERVALS)[number]): number[] {
    return CRON_MINUTES.filter((m) => isExecuteTick(at(m), interval));
}

describe('isExecuteInterval', () => {
    it('허용 목록의 값만 통과시킨다', () => {
        for (const v of EXECUTE_INTERVALS) expect(isExecuteInterval(v)).toBe(true);
    });

    it('60의 약수여도 목록에 없으면 거부한다', () => {
        expect(isExecuteInterval(1)).toBe(false);
        expect(isExecuteInterval(12)).toBe(false);
    });

    it('숫자가 아니거나 비정상이면 거부한다', () => {
        for (const v of [null, undefined, '10', NaN, Infinity, {}, [], 0, -5, 7.5]) {
            expect(isExecuteInterval(v)).toBe(false);
        }
    });
});

describe('parseExecuteInterval', () => {
    it('유효한 값은 그대로 돌려준다', () => {
        expect(parseExecuteInterval(5)).toBe(5);
        expect(parseExecuteInterval(60)).toBe(60);
    });

    it('손상된 값은 기본값으로 떨어진다', () => {
        for (const v of [null, undefined, 'abc', 7, NaN, {}]) {
            expect(parseExecuteInterval(v)).toBe(DEFAULT_EXECUTE_INTERVAL_MIN);
        }
    });
});

describe('isExecuteTick', () => {
    it('기준 분(:07)은 모든 간격에서 실행된다', () => {
        for (const interval of EXECUTE_INTERVALS) {
            expect(isExecuteTick(at(EXECUTE_BASE_MINUTE), interval)).toBe(true);
        }
    });

    it('60분이면 종전 스케줄(`7 13-21`)과 실행 시각이 같다', () => {
        expect(firingMinutes(60)).toEqual([7]);
    });

    it('5분이면 cron이 부르는 모든 틱에서 실행된다', () => {
        expect(firingMinutes(5)).toEqual(CRON_MINUTES);
    });

    it('간격마다 시(hour)당 60/interval번 실행된다', () => {
        expect(firingMinutes(10)).toEqual([7, 17, 27, 37, 47, 57]);
        expect(firingMinutes(15)).toEqual([7, 22, 37, 52]);
        expect(firingMinutes(20)).toEqual([7, 27, 47]);
        expect(firingMinutes(30)).toEqual([7, 37]);
    });

    it('시(hour) 경계를 넘어도 주기가 끊기지 않는다', () => {
        // 15:57 실행 → 다음은 16:07 (10분 뒤). 16:02는 실행이 아니다.
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 15, 57)), 10)).toBe(true);
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 16, 7)), 10)).toBe(true);
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 16, 2)), 10)).toBe(false);
    });

    it('기준 분 이전(:00~:06)은 60분 설정에서 실행되지 않는다', () => {
        for (const m of [0, 3, 6]) expect(isExecuteTick(at(m), 60)).toBe(false);
    });

    it('초·밀리초는 판정에 영향을 주지 않는다', () => {
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 15, 7, 59, 999)), 60)).toBe(true);
    });
});

describe('hasTickInWindow', () => {
    // ET와 UTC는 정시 오프셋만 다르므로 분(minute)이 같다 — 시를 몰라도 판정된다.
    const window = (startHH: number, startMM: number, endHH: number, endMM: number) => ({
        startMinute: startHH * 60 + startMM,
        endMinute: endHH * 60 + endMM,
    });

    it('창이 간격보다 길면 어떤 위치에서도 틱이 들어간다', () => {
        for (const interval of EXECUTE_INTERVALS) {
            expect(hasTickInWindow(interval, window(11, 0, 15, 0))).toBe(true);
        }
    });

    it('60분 간격 + :07을 비켜간 좁은 창은 매수가 영구히 0이 된다', () => {
        // 실행은 매시 :07 하나뿐인데 창이 11:10–11:50이면 그 안에 틱이 없다.
        // 로그에는 매 실행 `outside_entry_window`만 남아 설정 오류와 정상 상태가 구분되지 않는다.
        expect(hasTickInWindow(60, window(11, 10, 11, 50))).toBe(false);
    });

    it('같은 창이라도 간격이 짧으면 성립한다', () => {
        expect(hasTickInWindow(10, window(11, 10, 11, 50))).toBe(true);
    });

    it('창이 여러 시(hour)에 걸치면 60분 간격에서도 :07들이 들어간다', () => {
        expect(hasTickInWindow(60, window(11, 10, 14, 50))).toBe(true);
    });

    it('창 길이가 0 이하이면 거부한다', () => {
        expect(hasTickInWindow(10, window(11, 0, 11, 0))).toBe(false);
        expect(hasTickInWindow(10, window(15, 0, 11, 0))).toBe(false);
    });

    it('간격 값이 손상돼 있으면 기본값으로 판정한다', () => {
        expect(hasTickInWindow(7, window(11, 0, 15, 0))).toBe(true);
    });
});

describe('isExecuteTick — 지각 허용', () => {
    it('1분 늦게 진입한 틱도 실행한다 — 감사 흔적 없이 사라지면 안 된다', () => {
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 15, 8)), 10)).toBe(true);
    });

    it('2분 이상 벗어나면 실행하지 않는다', () => {
        expect(isExecuteTick(new Date(Date.UTC(2026, 7, 17, 15, 9)), 10)).toBe(false);
    });
});
