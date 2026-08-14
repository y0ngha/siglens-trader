/**
 * 신규 진입 허용 시간 창 (ET 기준).
 *
 * 창은 **동부 시간(ET)에 고정한다.** 개장 갭·첫 30분 변동성·마감 MOC 임밸런스는 전부
 * ET 기준으로 일어나는 현상이고, UTC나 KST에 고정하면 서머타임마다 창이 장중에서
 * 한 시간씩 밀려 "개장 직후 회피"라는 목적 자체가 반년마다 깨진다.
 *
 * 이 창은 **진입만** 막는다. 청산·손절·포지션 재평가는 정규장 내내 그대로 돈다 —
 * 리스크를 줄이는 유일한 경로를 시간으로 막으면 그 통제가 곧 결함이다.
 */

export interface EntryWindow {
    /** 자정 기준 분 (ET). 0~1440. */
    startMinute: number;
    endMinute: number;
}

const MINUTES_PER_DAY = 1440;

/**
 * 기본 창 ET 11:00–15:00.
 *
 * 개장(09:30 ET) 후 첫 90분과 마감(16:00 ET) 전 마지막 60분을 피한다. 앞쪽은 갭 정리와
 * 개장 경매 잔열이, 뒤쪽은 MOC 임밸런스가 지배하는 구간이라 신호 대비 슬리피지가 가장 나쁘다.
 * 한국 운영자 기준 여름 KST 00:00–04:00, 겨울 01:00–05:00.
 */
export const DEFAULT_ENTRY_WINDOW: EntryWindow = { startMinute: 11 * 60, endMinute: 15 * 60 };

/** 창 제한 없음과 동치인 값. 대시보드/API에서 이걸 저장하면 기능이 꺼진다. */
export const ENTRY_WINDOW_ALL_DAY: EntryWindow = { startMinute: 0, endMinute: MINUTES_PER_DAY };

const HH_MM = /^(\d{2}):(\d{2})$/;

/**
 * `'HH:MM'`을 자정 기준 분으로. 형식·범위를 벗어나면 `null`.
 *
 * `'24:00'`은 1440(하루 끝)으로 받는다 — 창을 하루 전체로 여는(=기능 끄는) 유일한 표기다.
 * API 검증도 이 함수를 그대로 쓴다: 파싱 규칙이 두 벌이면 대시보드가 받아준 값을
 * 런타임이 조용히 기본값으로 되돌리는 일이 생긴다.
 */
export function parseTimeOfDay(raw: unknown): number | null {
    if (typeof raw !== 'string') return null;
    const m = HH_MM.exec(raw);
    if (!m) return null;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (Number(m[2]) >= 60 || minutes > MINUTES_PER_DAY) return null;
    return minutes;
}

/**
 * `config.entry_window` 원본 JSON을 창으로 정규화한다.
 * 허용 형태: `{ start: 'HH:MM', end: 'HH:MM' }`. 파싱 불가·범위 밖·`start >= end`이면 기본 창.
 *
 * 자정을 넘는 창(`start > end`)은 지원하지 않는다. 미국 정규장은 자정을 넘지 않으므로
 * 그런 값은 설정 실수이지 표현하려던 의도가 아니고, 랩어라운드를 지원하면 `start === end`가
 * "0분"인지 "하루 전체"인지 영원히 모호해진다. 그래서 둘 다 기본 창으로 되돌린다.
 */
export function parseEntryWindow(raw: unknown): EntryWindow {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_ENTRY_WINDOW;
    const { start, end } = raw as { start?: unknown; end?: unknown };
    const startMinute = parseTimeOfDay(start);
    const endMinute = parseTimeOfDay(end);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
        return DEFAULT_ENTRY_WINDOW;
    }
    return { startMinute, endMinute };
}

/** 창을 `{ start, end }` 문자열 형태로 되돌린다 (감사 로그·API 응답용). */
export function formatEntryWindow(w: EntryWindow): { start: string; end: string } {
    const fmt = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { start: fmt(w.startMinute), end: fmt(w.endMinute) };
}

// 포매터 생성 비용이 크므로 모듈 로드 시 한 번만 만든다.
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
});

/**
 * `now`가 ET 기준 창 안인가.
 *
 * 끝은 **배타적**이다(`start <= m < end`). 정규장 마감을 16:00 exclusive로 보는 core의
 * `getEtSessionStatus` 관례와 맞춘다. `end === 1440`이면 `m < 1440`이 항상 참이라
 * 하루 전체가 자연히 들어온다.
 *
 * 시각을 읽을 수 없으면 **false**(진입 차단)를 반환한다. AI 사이징 게이트가 세운
 * 진입 fail-closed / 청산 fail-open 비대칭을 그대로 따른다 — 시계를 모르는 상태에서
 * 새 리스크를 여는 것보다 한 틱 쉬는 쪽이 싸다. 청산은 이 함수를 거치지 않는다.
 */
export function isWithinEntryWindow(now: Date, w: EntryWindow): boolean {
    if (!Number.isFinite(now.getTime())) return false;
    const parts = ET_PARTS.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const m = hour * 60 + minute;
    return m >= w.startMinute && m < w.endMinute;
}
