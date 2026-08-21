import { isFinitePositive } from '../validation.js';

/**
 * 권장 진입 구간 상단 대비 허용 오차 (1%).
 *
 * 구간은 AI가 낸 근사치이고 현재가는 틱 단위로 움직이므로, 상단에 정확히 붙은 값을
 * 소수점 차이로 걷어내면 게이트가 아니라 잡음이 된다. 반대로 오차를 크게 잡으면 막으려던
 * 추격 매수가 그대로 통과한다. 1%는 "구간 언저리"는 통과시키고 "구간을 벗어난 상승"은
 * 막는 지점이다.
 */
export const ENTRY_ZONE_TOLERANCE = 0.01;

/**
 * 현재가가 권장 진입 구간(`actionRecommendation.entryPrices`) 위로 달아났는가.
 *
 * 분석이 "$150 부근에서 진입"이라고 했는데 다음 execute 틱에서 가격이 $180이면, 점수는
 * 아직 매수 신호일 수 있다 — 분석 신선도 한도(1Hour 기준 2시간) 안이면 같은 분석이 계속
 * 쓰이기 때문이다. 그 상태로 시장가로 사면 손절선·목표가는 $150 기준 분석에서 나오는데
 * 진입만 $180이라 리스크:리워드가 뒤집힌다. 이 함수는 그 매수를 막는다.
 *
 * **상단만 본다.** 구간 아래(=더 싼 가격)는 막지 않는다 — 매수에 불리한 방향이 아니고,
 * 근거가 무너진 하락이라면 다음 분석에서 점수가 먼저 떨어진다. 하한을 두면 "분석이 원한
 * 것보다 싸다"는 이유로 매수를 거르게 되는데, 그건 이 게이트가 막으려는 문제가 아니다.
 *
 * 판단할 재료가 없으면 통과시킨다(fail-open): `entryPrices`가 비었거나 값이 전부
 * 비정상이면 게이트가 없던 때와 같이 동작한다. 이 축은 진입 품질을 높이는 장치이지
 * 매수의 전제조건이 아니다.
 */
export function exceedsEntryZone(
    price: number,
    entryPrices: readonly number[] | undefined,
    tolerance: number = ENTRY_ZONE_TOLERANCE,
): boolean {
    if (!isFinitePositive(price)) return false;
    const levels = (entryPrices ?? []).filter(isFinitePositive);
    if (levels.length === 0) return false;
    const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0;
    return price > Math.max(...levels) * (1 + safeTolerance);
}

/**
 * 진입가와 손절 트리거 사이에 있어야 할 최소 간격 (1%).
 *
 * `SUPPORT_BREAK_BUFFER`(0.5%)가 노이즈 한 틱을 걸러 주지만, 손절선이 진입가 바로 아래면
 * 그 버퍼조차 몇 틱이면 먹힌다. 이 값은 손실 크기를 제한하는 장치가 **아니다** — 손절선이
 * 노이즈 대역 밖에 있는지를 본다. 1%는 30분봉에서 손절선까지의 정상적인 거리이고,
 * 그보다 좁은 진입은 방향이 맞아도 흔들림에 먼저 털린다.
 */
export const MIN_STOP_ROOM = 0.01;

/**
 * 진입가가 손절 트리거보다 충분히 위인가 — 즉 손절선이 노이즈 대역 밖인가.
 *
 * 없어서 생긴 손실이 실측으로 3건이다(2026-08-19~20, 전건 손실). 예: PLTR을 175.65에
 * 사는데 지지선이 175.60 — 여유 **0.03%**. 10분 뒤 지지선을 0.037% 이탈해 전량 청산.
 * 방향이 틀려서 진 게 아니라 손절선이 호가 스프레드 안에 있어서 졌다.
 *
 * `exceedsEntryZone`이 못 잡는 층이다. 그쪽은 "분석이 말한 구간보다 비싸게 사는가"를 보고
 * 이쪽은 "손절선까지 여유가 있는가"를 본다. 셋 다 통과한 진입만 주문이 된다.
 *
 * **위에서 가장 먼저 서는 트리거를 기준으로 한다.** 청산 규칙은 분석 손절가(1.5)와
 * 지지선 이탈(2)을 각각 보므로, 둘 중 **높은** 쪽이 실제로 먼저 걸린다. 낮은 쪽을 쓰면
 * 있지도 않은 여유를 계산하게 된다.
 *
 * 판단할 재료가 없으면 통과시킨다(fail-open) — `exceedsEntryZone`과 같은 정책이다.
 * 이 축은 진입 품질 장치이지 매수의 전제조건이 아니다.
 */
export function hasStopRoom(
    price: number,
    levels: { supportLevel?: number; aiStopLoss?: number },
    supportBuffer: number,
    minRoom: number = MIN_STOP_ROOM,
): boolean {
    if (!isFinitePositive(price)) return true;

    const safeBuffer = Number.isFinite(supportBuffer) && supportBuffer >= 0 ? supportBuffer : 0;
    const safeRoom = Number.isFinite(minRoom) && minRoom >= 0 ? minRoom : 0;

    const triggers: number[] = [];
    if (isFinitePositive(levels.supportLevel)) {
        triggers.push(levels.supportLevel * (1 - safeBuffer));
    }
    if (isFinitePositive(levels.aiStopLoss)) triggers.push(levels.aiStopLoss);
    if (triggers.length === 0) return true;

    // 가장 높은 트리거가 가장 먼저 선다.
    return price >= Math.max(...triggers) * (1 + safeRoom);
}

/** 감사 로그·이메일에 남길 진입가–손절 트리거 간격 표기. 판단 재료가 없으면 `undefined`. */
export function formatStopRoom(
    price: number,
    levels: { supportLevel?: number; aiStopLoss?: number },
    supportBuffer: number,
): string | undefined {
    if (!isFinitePositive(price)) return undefined;
    const safeBuffer = Number.isFinite(supportBuffer) && supportBuffer >= 0 ? supportBuffer : 0;
    const triggers: number[] = [];
    if (isFinitePositive(levels.supportLevel)) {
        triggers.push(levels.supportLevel * (1 - safeBuffer));
    }
    if (isFinitePositive(levels.aiStopLoss)) triggers.push(levels.aiStopLoss);
    if (triggers.length === 0) return undefined;
    const trigger = Math.max(...triggers);
    return `${(((price - trigger) / price) * 100).toFixed(2)}% (트리거 $${trigger.toFixed(2)})`;
}

/** 감사 로그·이메일에 남길 구간 표기. 값이 없으면 `undefined`. */
export function formatEntryZone(entryPrices: readonly number[] | undefined): string | undefined {
    const levels = (entryPrices ?? []).filter(isFinitePositive);
    if (levels.length === 0) return undefined;
    const low = Math.min(...levels);
    const high = Math.max(...levels);
    return low === high ? `$${low}` : `$${low} ~ $${high}`;
}
