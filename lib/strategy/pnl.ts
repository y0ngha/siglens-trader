import { safeNumber } from '../validation.js';

/**
 * Realized P&L for a long-position sell, rounded to cents.
 * Profit when sellPrice > avgPrice. Quantity is the sold quantity.
 *
 * Rounding to cents (Math.round(...* 100) / 100) prevents floating-point
 * noise accumulation when values are stored and re-read from the DB as
 * numeric strings (e.g. (10.1 - 10) * 3 = 0.30000000000000004 → 0.3).
 *
 * **비유한 입력은 0으로 떨어진다.** Postgres `numeric`은 `NaN`을 받아들이고,
 * `SUM(...)`에 NaN이 하나라도 섞이면 합계 전체가 NaN이 된다. `getTodayRealizedPnl`이
 * 그 값을 돌려주면 `todayPnl < -maxDailyLoss` 비교가 **항상 false**가 되어 일일 손실
 * 차단기가 그날 내내 침묵한다. 손익을 0으로 기록하는 것은 부정확하지만, 차단기를
 * 통째로 무력화하는 것보다 낫다 — 손상된 값은 차단기의 입력이 아니라 수동 확인 대상이다.
 */
export function realizedPnlForSell(sellPrice: number, avgPrice: number, quantity: number): number {
    const pnl =
        (safeNumber(sellPrice, NaN) - safeNumber(avgPrice, NaN)) * safeNumber(quantity, NaN);
    if (!Number.isFinite(pnl)) {
        console.warn('[pnl] 비유한 입력으로 실현손익을 0으로 기록:', {
            sellPrice,
            avgPrice,
            quantity,
        });
        return 0;
    }
    return Math.round(pnl * 100) / 100;
}
