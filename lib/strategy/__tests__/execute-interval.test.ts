import { describe, it, expect } from 'vitest';
import {
    DEFAULT_EXECUTE_INTERVAL_MIN,
    EXECUTE_BASE_MINUTE,
    EXECUTE_INTERVALS,
    isExecuteInterval,
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
