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

/** 감사 로그·이메일에 남길 구간 표기. 값이 없으면 `undefined`. */
export function formatEntryZone(entryPrices: readonly number[] | undefined): string | undefined {
    const levels = (entryPrices ?? []).filter(isFinitePositive);
    if (levels.length === 0) return undefined;
    const low = Math.min(...levels);
    const high = Math.max(...levels);
    return low === high ? `$${low}` : `$${low} ~ $${high}`;
}
