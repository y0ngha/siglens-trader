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
 * 진입가와 손절 레벨 사이에 있어야 할 최소 간격 (기본 0.5%).
 *
 * 손실 크기를 제한하는 장치가 **아니다** — 손절선이 노이즈 대역 밖에 있는지를 본다.
 *
 * 값의 근거는 양쪽에서 온다. 아래로는 실측 3건(2026-08-19~20, 여유 0.03~0.2%, 전건 손실)이
 * 확실히 걸려야 하고, 위로는 **분석이 실제로 그어 주는 손절선까지의 거리**를 넘으면 안 된다 —
 * siglens-core의 폴백 손절가는 `진입가 − 1.5×ATR`이라 확보 가능한 여유가 곧 `1.5×ATR/가격`이다.
 * 1%로 잡으면 ATR이 가격의 0.667% 미만인 종목은 매 틱 영구 차단되는데, 30분봉에서는 흔한
 * 영역이라 게이트가 아니라 정지 버튼이 된다. 0.5%는 실측 실패의 2.5~16배이면서
 * ATR ≥ 가격의 0.333%면 통과시킨다.
 *
 * 운영 중 조정은 `POST /api/config`의 `min_stop_room_pct`(퍼센트 단위, 0이면 off).
 * 재배포가 필요 없어야 하는 값이다 — 시장 국면에 따라 조여야 할지 풀어야 할지가 바뀐다.
 */
export const MIN_STOP_ROOM = 0.005;

/**
 * 진입가가 손절 레벨보다 충분히 위인가 — 즉 손절선이 노이즈 대역 밖인가.
 *
 * 없어서 생긴 손실이 실측으로 3건이다(2026-08-19~20, 전건 손실). 예: PLTR을 175.65에
 * 사는데 지지선이 175.60 — 여유 **0.03%**. 10분 뒤 지지선을 이탈해 전량 청산. 방향이
 * 틀려서 진 게 아니라 손절선이 호가 스프레드 안에 있어서 졌다.
 *
 * `exceedsEntryZone`이 못 잡는 층이다. 그쪽은 "분석이 말한 구간보다 비싸게 사는가"를 보고
 * 이쪽은 "손절선까지 여유가 있는가"를 본다. 실측 3건은 전부 진입 구간 **안**이었다.
 *
 * **레벨 중 가장 높은 쪽을 본다.** 청산 규칙은 분석 손절가(1.5)와 지지선 이탈(2)을 각각
 * 보므로, 높은 쪽이 먼저 걸린다. 지지선 쪽 실제 트리거는 `SUPPORT_BREAK_BUFFER`만큼
 * 아래지만 그 버퍼를 여기서 다시 빼지는 않는다 — 두 상수를 곱하면 한쪽을 조정할 때마다
 * 다른 쪽 문턱이 조용히 움직이고, 실제로 그 결합 때문에 `SUPPORT_BREAK_BUFFER`가 이
 * 계산에서 아무 일도 하지 않는 구간이 생겼다. 명목 레벨까지의 거리를 재는 쪽이 0.5%만큼
 * 더 보수적이고, 이 축은 정확한 트리거 계산이 아니라 거리 휴리스틱이다.
 *
 * 판단할 재료가 없으면 통과시킨다(fail-open) — `exceedsEntryZone`과 같은 정책이다.
 * 이 축은 진입 품질 장치이지 매수의 전제조건이 아니다.
 */
export function hasStopRoom(
    price: number,
    levels: { supportLevel?: number; aiStopLoss?: number },
    minRoom: number = MIN_STOP_ROOM,
): boolean {
    if (!isFinitePositive(price)) return true;
    const safeRoom = Number.isFinite(minRoom) && minRoom >= 0 ? minRoom : MIN_STOP_ROOM;

    const level = highestStopLevel(levels);
    if (level === null) return true;

    return price >= level * (1 + safeRoom);
}

/** 가장 먼저 걸리는(=가장 높은) 손절 레벨. 쓸 수 있는 값이 없으면 `null`. */
function highestStopLevel(levels: { supportLevel?: number; aiStopLoss?: number }): number | null {
    const candidates = [levels.supportLevel, levels.aiStopLoss].filter(isFinitePositive);
    return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * 진입에 요구하는 최소 손익비 (기본 1.5).
 *
 * `MIN_STOP_ROOM`이 하방만 보는 것의 **대칭**이다. 그쪽이 없어서 손절선이 스프레드 안인
 * 진입을 했다면, 이쪽이 없어서 **먹을 게 없는 진입**을 했다.
 *
 * 실측(426틱)이 이걸 요구한다: 분석 익절가가 현재가보다 **아래**인 경우가 11.5%,
 * 저항선이 아래인 경우가 14.6%였다 — 사는 순간 익절 조건이 성립해 같은 틱에 나간다.
 * 익절가가 위에 있을 때조차 상방 여유 중앙값이 **0.74%**이고 63%가 1% 미만이었다.
 * 그 결과 손익비 중앙값이 **1.12**, 즉 손익분기 승률 47%다 — 슬리피지·수수료 전 기준이고
 * 스톱이 타깃보다 노이즈에 먼저 닿는 것을 감안하면 그보다 낮다. 0승 7패의 원인은
 * 신호 품질이 아니라 여기였다.
 *
 * 1.5는 실측에서 진입의 42%가 통과하는 지점이다. 2로 올리면 33%가 남는다.
 * `min_rr` 설정으로 조정한다(0이면 게이트 off).
 */
export const MIN_RISK_REWARD = 1.5;

/** 손익비 계산에 쓰는 레벨. 전부 분석 결과에서 온다. */
export interface RiskRewardLevels {
    /** `actionRecommendation.takeProfitPrices[0]` — 청산 규칙 4.5가 보는 값. */
    takeProfit?: number;
    /** `keyLevels.resistance[0]` — 규칙 5가 밴드 하단(−2%)에서 발동한다. */
    resistance?: number;
    /** `priceTargets.bullish` 첫 목표 — 규칙 5b가 95% 지점에서 발동한다. */
    target?: number;
    /** `keyLevels.support[0]` — 규칙 2. */
    supportLevel?: number;
    /** `actionRecommendation.stopLoss` — 규칙 1.5. */
    aiStopLoss?: number;
}

/** 저항선 익절이 서는 지점(밴드 하단)과 목표가 익절이 서는 지점(95%). */
const RESISTANCE_TRIGGER_RATIO = 0.98;
const TARGET_TRIGGER_RATIO = 0.95;

/**
 * 위로 갔을 때 **가장 먼저 서는 익절 트리거** 가격. 없으면 `null`.
 *
 * 청산 규칙이 4.5(분석 익절가) → 5(저항 밴드) → 5b(목표가) 순으로 배치돼 있지만, 가격이
 * 올라가며 실제로 먼저 닿는 것은 **그중 가장 낮은 값**이다. 보상은 그 지점까지다 —
 * 더 먼 목표를 근거로 손익비를 계산하면 도달하지 못할 이익을 세는 셈이 된다.
 */
export function firstUpsideExit(price: number, levels: RiskRewardLevels): number | null {
    if (!isFinitePositive(price)) return null;
    const candidates = [
        levels.takeProfit,
        isFinitePositive(levels.resistance)
            ? levels.resistance * RESISTANCE_TRIGGER_RATIO
            : undefined,
        isFinitePositive(levels.target) ? levels.target * TARGET_TRIGGER_RATIO : undefined,
    ].filter((v): v is number => isFinitePositive(v) && v > price);
    return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * 진입가 기준 손익비. 계산할 수 없으면 `null`.
 *
 * 위로 갈 자리가 없으면(모든 익절 레벨이 진입가 이하) **0**을 돌려준다 — `null`(판단 불가)과
 * 구분해야 한다. 전자는 "먹을 게 없다"는 정보이고 후자는 "모르겠다"이며, 후자만 통과시킨다.
 */
export function riskRewardRatio(price: number, levels: RiskRewardLevels): number | null {
    if (!isFinitePositive(price)) return null;
    const stop = highestStopLevel({
        supportLevel: levels.supportLevel,
        aiStopLoss: levels.aiStopLoss,
    });
    if (stop === null || stop >= price) return null; // 하방을 모르면 판단 불가
    const upside = firstUpsideExit(price, levels);
    // 익절 레벨이 전부 진입가 이하 = 상방 0. 판단 불가가 아니라 "없다"이다.
    const hasAnyUpside =
        isFinitePositive(levels.takeProfit) ||
        isFinitePositive(levels.resistance) ||
        isFinitePositive(levels.target);
    if (upside === null) return hasAnyUpside ? 0 : null;
    return (upside - price) / (price - stop);
}

/**
 * 손익비가 요구치 이상인가 — 즉 **먹을 게 있는 자리인가**.
 *
 * 판단 재료가 없으면 통과시킨다(fail-open). 나머지 진입 가드와 같은 정책이다 — 이 축은
 * 진입 품질 장치이지 매수의 전제조건이 아니다.
 */
export function hasRiskReward(
    price: number,
    levels: RiskRewardLevels,
    minRr: number = MIN_RISK_REWARD,
): boolean {
    const safeMin = Number.isFinite(minRr) && minRr >= 0 ? minRr : MIN_RISK_REWARD;
    if (safeMin === 0) return true;
    const rr = riskRewardRatio(price, levels);
    return rr === null || rr >= safeMin;
}

/** 감사 로그·이메일에 남길 손익비 표기. 판단 재료가 없으면 `undefined`. */
export function formatRiskReward(price: number, levels: RiskRewardLevels): string | undefined {
    const rr = riskRewardRatio(price, levels);
    if (rr === null) return undefined;
    const up = firstUpsideExit(price, levels);
    return up === null
        ? '0 (상방 없음 — 익절 레벨이 진입가 이하)'
        : `${rr.toFixed(2)} (익절 $${up.toFixed(2)})`;
}

/** 감사 로그·이메일에 남길 진입가–손절 레벨 간격 표기. 판단 재료가 없으면 `undefined`. */
export function formatStopRoom(
    price: number,
    levels: { supportLevel?: number; aiStopLoss?: number },
): string | undefined {
    if (!isFinitePositive(price)) return undefined;
    const level = highestStopLevel(levels);
    if (level === null) return undefined;
    return `${(((price - level) / price) * 100).toFixed(2)}% (손절 레벨 $${level.toFixed(2)})`;
}

/** 감사 로그·이메일에 남길 구간 표기. 값이 없으면 `undefined`. */
export function formatEntryZone(entryPrices: readonly number[] | undefined): string | undefined {
    const levels = (entryPrices ?? []).filter(isFinitePositive);
    if (levels.length === 0) return undefined;
    const low = Math.min(...levels);
    const high = Math.max(...levels);
    return low === high ? `$${low}` : `$${low} ~ $${high}`;
}
