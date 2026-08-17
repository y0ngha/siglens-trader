/**
 * execute cron 실행 간격 — 가격 조건을 얼마나 자주 보는가.
 *
 * 매수 진입가, 손절선, 익절선은 전부 execute 틱 안에서만 판정된다. 그래서 이 간격이 곧
 * **가격 조건 반응 지연의 상한**이다. 60분이면 손절선이 뚫린 뒤 최대 60분간 아무도 보지
 * 않는다.
 *
 * node-cron 스케줄(`server/app.ts`)은 5분마다 핸들러를 호출하고, 실제 실행 여부는 이
 * 함수가 정한다. 스케줄 문자열 자체를 DB 설정으로 바꾸려면 태스크 재등록(=재시작)이
 * 필요한데, 게이트 하나면 대시보드에서 바꾸는 즉시 다음 틱부터 적용된다. 건너뛴 틱의
 * 비용은 설정 조회 한 번이다.
 */

export const EXECUTE_INTERVALS = [5, 10, 15, 20, 30, 60] as const;
export type ExecuteInterval = (typeof EXECUTE_INTERVALS)[number];

/**
 * 기본값 10분. 종전 동작은 60분이었고, 그 60분이 이 파일이 생긴 이유다.
 *
 * 5분이 아닌 이유는 비용이다 — 한 틱은 심볼당 FMP 호출 2회(현재가 quote + 컨플루언스 봉)를
 * 쓰므로 간격을 절반으로 줄이면 호출량이 두 배가 된다. 10분은 반응 지연을 1/6로 줄이면서
 * 호출량을 12배가 아닌 6배로 묶는 지점이다.
 */
export const DEFAULT_EXECUTE_INTERVAL_MIN: ExecuteInterval = 10;

/**
 * 시(hour) 안에서 실행 분을 세는 기준점.
 *
 * 정각이 아니라 :07인 이유 — 분석 cron이 정각에 시작하므로, 정각에 점수를 매기면 아직
 * 저장되지 않은 이번 사이클 분석 대신 한 사이클 묵은 것을 읽는다. 종전 스케줄
 * (`7 13-21 * * 1-5`)의 오프셋이 그것이었고, 여기서 그대로 이어받는다. 그래서 간격을
 * 60분으로 두면 실행 시각이 종전과 분 단위로 동일하다.
 */
export const EXECUTE_BASE_MINUTE = 7;

export function isExecuteInterval(value: unknown): value is ExecuteInterval {
    return (EXECUTE_INTERVALS as readonly unknown[]).includes(value);
}

/** 저장된 값이 손상됐거나 없으면 기본값으로 떨어진다 (런타임 방어). */
export function parseExecuteInterval(value: unknown): ExecuteInterval {
    return isExecuteInterval(value) ? value : DEFAULT_EXECUTE_INTERVAL_MIN;
}

/**
 * 지각 허용치(분).
 *
 * 게이트는 분 단위 등식이라 관용 구간이 없으면, 이벤트 루프가 밀려 핸들러 진입이 분 경계를
 * 넘긴 틱이 통째로 사라진다 — `startCronRun`보다 앞이라 `cron_runs`에도 흔적이 남지 않는다.
 * cron은 5분 간격으로만 발화하고 최소 실행 간격도 5분이므로, 1분을 허용해도 한 간격 안에서
 * 두 번 실행될 수는 없다.
 */
const LATE_TICK_TOLERANCE_MIN = 1;

/**
 * 이 시각이 실행 틱인가.
 *
 * 분(minute)만 본다 — cron이 `Etc/UTC`로 등록돼 있고, 모든 후보 간격(5·10·15·20·30·60)이
 * 60의 약수라 시(hour) 경계에서 주기가 끊기지 않는다.
 */
export function isExecuteTick(now: Date, interval: ExecuteInterval): boolean {
    const offset = (now.getUTCMinutes() - EXECUTE_BASE_MINUTE + 60) % interval;
    return offset <= LATE_TICK_TOLERANCE_MIN;
}

/**
 * 이 간격의 실행 틱이 진입 창 안에 하나라도 존재하는가.
 *
 * 실행 틱은 UTC 분(`(분 − 7) mod interval === 0`)에 고정인데 진입 창은 ET 시:분으로 임의
 * 지정할 수 있다. ET는 UTC에서 정시 오프셋(−4/−5시간)만큼만 다르므로 **분(minute)은 두 시계가
 * 같다** — 그래서 시(hour)를 몰라도 분만으로 교집합을 판정할 수 있다.
 *
 * 창의 길이가 간격 이상이면 어떤 위치에서도 틱이 하나는 들어가므로 곧바로 참이다. 그보다
 * 짧을 때만 창에 걸치는 분들을 훑는다.
 */
export function hasTickInWindow(
    intervalMin: number,
    window: { startMinute: number; endMinute: number },
): boolean {
    const interval = isExecuteInterval(intervalMin) ? intervalMin : DEFAULT_EXECUTE_INTERVAL_MIN;
    const span = window.endMinute - window.startMinute;
    if (!Number.isFinite(span) || span <= 0) return false;
    if (span >= interval) return true;
    for (let m = window.startMinute; m < window.endMinute; m++) {
        const offset = ((((m % 60) - EXECUTE_BASE_MINUTE + 60) % interval) + interval) % interval;
        if (offset <= LATE_TICK_TOLERANCE_MIN) return true;
    }
    return false;
}
