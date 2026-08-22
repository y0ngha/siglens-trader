import type { Db } from '../../lib/db/index.js';
import { getConfigValue, getDryRunCashFlowUsd } from '../../lib/db/queries.js';
import { getBuyingPower } from '../../lib/trading/account.js';

/**
 * `dry_run` 모의 계좌의 **초기 예치금** (USD). `config.dry_run_cash_usd`로 덮어쓴다.
 *
 * 잔고가 아니라 시작 자본이다 — 현재 잔고는 여기에 체결 원장의 순현금흐름을 더한 값이고,
 * 그래서 모의 계좌도 손익에 따라 늘고 준다.
 */
export const DEFAULT_DRY_RUN_CASH_USD = 5000;

/**
 * 매수 가능 현금 (USD). 세 모드 모두 **같은 뜻의 숫자**를 낸다 — "지금 쓸 수 있는 돈".
 *
 * - `auto` / `semi_auto`: 브로커 실잔고. 두 모드 다 실계좌에 주문이 나가므로
 *   (semi_auto는 승인 시점에) 실제 현금으로 판단해야 한다. 조회 실패는 `null`.
 * - `dry_run`: 예치금(`dry_run_cash_usd`) + 체결 원장의 순현금흐름. 저장 잔고가 아니라
 *   `trades`에서 도출한다 — 근거는 {@link getDryRunCashFlowUsd}.
 *
 * **execute cron과 대시보드가 이 함수를 공유한다.** 같은 계산을 두 곳에 두면 화면에
 * 찍히는 현금과 실제 사이징이 쓰는 현금이 갈라지고, 그 불일치는 조용하다 —
 * 대시보드가 "$4,500 있음"이라 하는데 주문은 다른 예산으로 나가는 상태가 된다.
 */
export async function getAvailableCashUsd(db: Db, tradingMode: string): Promise<number | null> {
    if (tradingMode !== 'dry_run') {
        return getBuyingPower('USD').catch(() => null);
    }
    const deposit =
        (await getConfigValue<number>(db, 'dry_run_cash_usd').catch(() => null)) ??
        DEFAULT_DRY_RUN_CASH_USD;
    const flow = await getDryRunCashFlowUsd(db).catch(() => 0);
    // 원장이 예치금보다 크게 마이너스여도 음수 현금은 의미가 없다.
    return Math.max(0, deposit + flow);
}
