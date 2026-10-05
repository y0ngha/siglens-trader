/**
 * 총자산 연동 사이징 — 칸 수와 금액 한도를 계좌 총자산에서 도출한다
 * (docs/specs/2026-10-05-equity-scaled-sizing-design.md).
 *
 * 종전에는 칸 수(`mr_slots`)와 세 금액 한도(`max_position_size`·`max_total_exposure`·
 * `max_daily_loss_usd`)가 DB 설정이었다. 입금하거나 손익이 나면 한도가 계좌와 어긋났고, 작은 계좌에서는
 * 칸 예산이 주가보다 작아 신호의 절반 이상을 1주도 사지 못했다(Toss 주문은 정수 주만 받는다).
 *
 * 순수 함수다 — 시세·현금·지난 기록은 호출자(`api/cron/execute.ts`)가 넘긴다.
 */

/** 칸 수 상한. K=8/10/12가 40종목에서 같고 상위 5 제외 검증에서 8이 낫다(2026-09-24 스펙 §2.4.3). */
export const MAX_SLOTS = 8;

/** 칸 하나로 감시 종목의 이 비율 이상을 최소 1주 살 수 있어야 한다 — "신호 4개 중 3개는 산다". */
export const TARGET_COVERAGE = 0.75;

/**
 * 가격 표본이 감시 종목의 이 비율 미만이면 표본으로 칸 수를 정하지 않는다. 시세 프리페치가 실행 마감으로
 * 잘렸거나 FMP 장애다 — 부분 표본으로 정한 K가 다음 날까지 이어지지 않게 한다.
 */
export const MIN_PRICE_SAMPLE_RATIO = 0.5;

/**
 * 총자산 계산 자체가 틀렸을 때의 독립 방어선(브로커 잔고 응답 오류 등). 지원 범위 $100,000 기준 —
 * 그보다 큰 계좌는 총 노출이 여기에 묶이므로 계좌가 커지면 올린다.
 */
export const ABS_MAX_POSITION_USD = 25_000;
export const ABS_MAX_TOTAL_EXPOSURE_USD = 110_000;

/**
 * 일일 손실 한도 = 종목 한도(≈ 칸)의 16%. 총자산의 고정 %로 두면 칸이 계좌에서 차지하는 몫이 클수록
 * (K가 작을수록) 종목 하나의 하락만으로 진입이 막힌다. 칸 기준이면 K=8에서 종전 설정($500 / $25,000)과
 * 같고, 어느 K에서나 "한 칸이 하루 16% 빠지면"이 기준이다(스펙 §3).
 */
export const DAILY_LOSS_SLOT_FRACTION = 0.16;

/** `prices` = 이번 런에서 시세로 계산 · `carried` = 마지막 `prices` 기록을 이어 씀 · `default` = 기록 없음. */
export type SlotsSource = 'prices' | 'carried' | 'default';

export interface SlotsReading {
    slots: number;
    source: SlotsSource;
    /** 고른 K에서의 커버리지(0~1). 시세로 계산하지 않았으면 null. */
    coverage: number | null;
    /** 커버리지 계산에 쓴 가격 표본 수. */
    priceCount: number;
}

export interface Sizing {
    equity: number;
    slots: number;
    slotsSource: SlotsSource;
    coverage: number | null;
    priceCount: number;
    /** 총자산 ÷ 칸 수 — 종목당 매수 금액의 주 규칙. */
    slotBudget: number;
    maxPositionSize: number;
    maxTotalExposure: number;
    dailyLossLimit: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isValidSlots = (v: unknown): v is number =>
    finite(v) && Number.isInteger(v) && v >= 1 && v <= MAX_SLOTS;

/**
 * 총자산 = 매수 가능 현금 + 보유 평가액(실시간 가격, 없으면 평단). 현금을 모르면(브로커 조회 실패) null —
 * 호출자는 진입하지 않는다(스펙 §5). 미체결 매수는 넣지 않는다: 브로커가 이미 현금에서 뺐는지 모드마다
 * 달라 이중 계산이 될 수 있다(빼면 칸이 약간 작아지는 보수적 오차, 2026-09-24 스펙 §3.1).
 */
export function accountEquity(
    cash: number | null,
    holdings: ReadonlyArray<{ quantity: number; avgPrice: number; price: number }>,
): number | null {
    if (!finite(cash)) return null;
    let held = 0;
    for (const h of holdings) {
        const qty = finite(h.quantity) && h.quantity > 0 ? h.quantity : 0;
        const mark = finite(h.price) && h.price > 0 ? h.price : finite(h.avgPrice) ? h.avgPrice : 0;
        held += Math.max(0, mark) * qty;
    }
    return Math.max(0, cash) + held;
}

/** 마지막 기록의 K를 이어 쓴다. 기록이 없거나 손상이면 `MAX_SLOTS` — 손실 한도가 가장 작은(엄격한) 쪽. */
export function carriedSlots(last: number | null): SlotsReading {
    return isValidSlots(last)
        ? { slots: last, source: 'carried', coverage: null, priceCount: 0 }
        : { slots: MAX_SLOTS, source: 'default', coverage: null, priceCount: 0 };
}

/**
 * 칸 수 K — 칸 예산(총자산 ÷ K)으로 감시 종목의 `TARGET_COVERAGE` 이상을 1주 살 수 있는 가장 큰 K.
 * 어느 K로도 안 되면 1(그 구간은 싼 종목만 산다). 표본이 `universeSize`의 절반 미만이면 `carriedSlots`.
 *
 * `prices`는 감시 종목별 실시간 가격이다. 양수·유한이 아닌 값(조회 실패)은 표본에서 뺀다.
 */
export function slotsFromPrices(
    equity: number,
    prices: ReadonlyArray<unknown>,
    universeSize: number,
    carried: number | null,
): SlotsReading {
    const sample = prices.filter((p): p is number => finite(p) && p > 0);
    const minSample = Math.max(1, Math.ceil(Math.max(0, universeSize) * MIN_PRICE_SAMPLE_RATIO));
    if (sample.length < minSample) return carriedSlots(carried);

    const eq = finite(equity) ? Math.max(0, equity) : 0;
    const coverageAt = (budget: number) => sample.filter((p) => p <= budget).length / sample.length;
    for (let k = MAX_SLOTS; k >= 1; k--) {
        const coverage = coverageAt(eq / k);
        if (coverage >= TARGET_COVERAGE) {
            return { slots: k, source: 'prices', coverage, priceCount: sample.length };
        }
    }
    return { slots: 1, source: 'prices', coverage: coverageAt(eq), priceCount: sample.length };
}

/** 총자산과 칸 수에서 사이징 전부를 낸다. NaN·음수 총자산은 0 — 한도가 꺼지는 게 아니라 0이 된다. */
export function deriveSizing(equity: number, reading: SlotsReading): Sizing {
    const eq = finite(equity) ? Math.max(0, equity) : 0;
    const slots = isValidSlots(reading.slots) ? reading.slots : MAX_SLOTS;
    const slotBudget = eq / slots;
    const maxPositionSize = Math.min(slotBudget, ABS_MAX_POSITION_USD);
    return {
        equity: eq,
        slots,
        slotsSource: reading.source,
        coverage: reading.coverage,
        priceCount: reading.priceCount,
        slotBudget,
        maxPositionSize,
        maxTotalExposure: Math.min(eq, ABS_MAX_TOTAL_EXPOSURE_USD),
        dailyLossLimit: maxPositionSize * DAILY_LOSS_SLOT_FRACTION,
    };
}
