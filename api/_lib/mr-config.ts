import { getConfigValue } from '../../lib/db/queries.js';
import type { Db } from '../../lib/db/index.js';
import { DEFAULT_MR_PARAMS, type MeanReversionParams } from '../../lib/strategy/mean-reversion.js';

/**
 * 전략 설정 읽기 — execute가 런당 한 번 부른다.
 *
 * 범위 밖·타입 불일치·조회 실패는 기본값으로 떨어진다. 이것은 손상된 행에 대한 **런타임 방어**이지
 * API 검증의 대체가 아니다 — 잘못된 값은 `POST /api/config`가 저장 시점에 거부한다. 범위는 그
 * 엔드포인트의 `NUMERIC_BOUNDS`와 같다.
 */
const inRange = (v: unknown, lo: number, hi: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;

export async function readMrParams(db: Db): Promise<MeanReversionParams> {
    const [rsiEntry, maxHoldDays, stopAtr, regimeFilter] = await Promise.all(
        ['mr_rsi_entry', 'mr_max_hold_days', 'mr_stop_atr', 'mr_regime_filter'].map((key) =>
            getConfigValue<unknown>(db, key).catch(() => null),
        ),
    );
    return {
        rsiEntry: inRange(rsiEntry, 1, 50, DEFAULT_MR_PARAMS.rsiEntry),
        maxHoldDays: Math.round(inRange(maxHoldDays, 1, 60, DEFAULT_MR_PARAMS.maxHoldDays)),
        stopAtr: inRange(stopAtr, 0, 20, DEFAULT_MR_PARAMS.stopAtr),
        regimeFilter:
            typeof regimeFilter === 'boolean' ? regimeFilter : DEFAULT_MR_PARAMS.regimeFilter,
    };
}

/**
 * dry_run 모의 체결 비용(편도, bp). 거래당 기대값이 ±0.2% 수준이라 왕복 비용이 부호를 바꿀 수
 * 있다(스펙 §4.4). 10bp는 토스 해외주식 수수료 수준을 가정한 값이고 실제 수수료는 확인하지 않았다.
 */
export const DEFAULT_DRY_RUN_COST_BPS = 10;

export async function readDryRunCostBps(db: Db): Promise<number> {
    const stored = await getConfigValue<unknown>(db, 'dry_run_cost_bps').catch(() => null);
    return inRange(stored, 0, 100, DEFAULT_DRY_RUN_COST_BPS);
}
