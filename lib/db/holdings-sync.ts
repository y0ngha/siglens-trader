import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { positions } from './schema.js';
import { openPosition } from './queries.js';

/**
 * 브로커 보유 → DB `positions` 동기화 (docs/specs/2026-11-06-holdings-sync-design.md).
 *
 * reconcile의 보유 대조와 대시보드의 "Toss 보유 동기화"가 **같은 비교**를 쓴다 — 두 벌이면
 * 메일이 말하는 불일치와 동기화가 고치는 불일치가 조용히 갈라진다.
 *
 * trades에는 쓰지 않는다: 동기화는 체결이 아니라 장부 교정이고, 가짜 거래는 실현 손익과
 * 일일 손실·거래 한도를 오염시킨다. 변경 전후는 호출부가 `cron_runs`에 남긴다.
 */

/** 브로커 보유의 최소 형태 — lib/db가 lib/trading 타입에 기대지 않도록 따로 둔다. */
export interface BrokerHoldingLike {
    symbol: string;
    quantity: number;
    avgPrice: number;
    currency: string;
    marketCountry: string;
}

export interface OpenPositionLike {
    id: number;
    symbol: string;
    quantity: number;
    avgPrice: string | number;
}

/** 수량 허용오차 — 소수 주(fractional US shares) 잡음. reconcile과 같은 값. */
export const HOLDINGS_QTY_EPSILON = 0.01;
/** 평단 허용오차 — 반 센트. 그보다 작은 차이는 표시 반올림이다. */
export const HOLDINGS_PRICE_EPSILON = 0.005;

export type HoldingsSyncItem =
    | {
          action: 'update';
          symbol: string;
          positionId: number;
          db: { quantity: number; avgPrice: number };
          broker: { quantity: number; avgPrice: number };
          /** 브로커 원 수량(소수 주 포함) — 경보 문구용. `broker.quantity`는 내린 값이다. */
          brokerQuantity: number;
          /** 수량이 어긋났는가 — reconcile 경보는 이것만 본다(평단 차이는 경보하지 않는다). */
          quantityMismatch: boolean;
      }
    | {
          action: 'close';
          symbol: string;
          positionId: number;
          db: { quantity: number; avgPrice: number };
          /** 브로커 원 수량(소수 주 포함). 0이 아니면 정수로 내린 값이 0이었다는 뜻이다. */
          brokerQuantity: number;
      }
    | {
          action: 'open';
          symbol: string;
          broker: { quantity: number; avgPrice: number };
      };

export function isUsHolding(h: Pick<BrokerHoldingLike, 'currency' | 'marketCountry'>): boolean {
    return h.currency === 'USD' || h.marketCountry === 'US';
}

/**
 * DB 열린 포지션과 브로커 보유의 차이. 순수 함수.
 *
 * - 열린 포지션은 **모두** 본다(봇 장부에 있으면 봇 소관).
 * - 브로커에만 있는 보유는 `managedSymbols`(봇이 살 수 있었던 심볼)만 — 운영자가 같은 계좌에
 *   손으로 산 종목은 장부 불일치가 아니다.
 * - `positions.quantity`가 정수라 브로커 소수 주는 내린다. 내린 값이 0이면 "없음"과 같다.
 */
export function diffHoldings(
    openPositions: readonly OpenPositionLike[],
    holdings: readonly BrokerHoldingLike[],
    managedSymbols: ReadonlySet<string>,
): HoldingsSyncItem[] {
    const usHoldings = holdings.filter(isUsHolding);
    const brokerBySymbol = new Map(usHoldings.map((h) => [h.symbol, h]));
    const items: HoldingsSyncItem[] = [];

    for (const pos of openPositions) {
        const dbQty = Number(pos.quantity);
        const dbAvg = Number(pos.avgPrice);
        const broker = brokerBySymbol.get(pos.symbol);
        const rawQty = broker ? broker.quantity : 0;
        const brokerQty = Math.floor(rawQty + 1e-9);
        if (!broker || brokerQty <= 0) {
            items.push({
                action: 'close',
                symbol: pos.symbol,
                positionId: pos.id,
                db: { quantity: dbQty, avgPrice: dbAvg },
                brokerQuantity: rawQty,
            });
            continue;
        }
        const quantityMismatch = Math.abs(dbQty - rawQty) > HOLDINGS_QTY_EPSILON;
        // 평단을 못 읽었으면(0) DB 값을 유지한다 — 0으로 덮으면 손익·노출이 깨진다.
        const targetAvg = broker.avgPrice > 0 ? broker.avgPrice : dbAvg;
        const priceMismatch = Math.abs(dbAvg - targetAvg) > HOLDINGS_PRICE_EPSILON;
        if (!quantityMismatch && !priceMismatch) continue;
        // 소수 주만 다른 경우(DB 3 vs 브로커 3.4)는 내린 값이 DB와 같아 정수 장부로 고칠 것이
        // 없다 — 항목은 남겨 경보(`quantityMismatch`)에 쓰고, 적용에서는 `actionableItems`가 뺀다.
        items.push({
            action: 'update',
            symbol: pos.symbol,
            positionId: pos.id,
            db: { quantity: dbQty, avgPrice: dbAvg },
            broker: { quantity: brokerQty, avgPrice: priceMismatch ? targetAvg : dbAvg },
            brokerQuantity: rawQty,
            quantityMismatch,
        });
    }

    const dbSymbols = new Set(openPositions.map((p) => p.symbol));
    for (const h of usHoldings) {
        if (dbSymbols.has(h.symbol) || !managedSymbols.has(h.symbol)) continue;
        const qty = Math.floor(h.quantity + 1e-9);
        if (qty <= 0 || !(h.avgPrice > 0)) continue;
        items.push({
            action: 'open',
            symbol: h.symbol,
            broker: { quantity: qty, avgPrice: h.avgPrice },
        });
    }

    return items.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** 장부를 실제로 바꾸는 항목만 — 소수 주 차이뿐인 `update`는 적용할 것이 없다. */
export function actionableItems(items: readonly HoldingsSyncItem[]): HoldingsSyncItem[] {
    return items.filter(
        (it) =>
            it.action !== 'update' ||
            it.db.quantity !== it.broker.quantity ||
            it.db.avgPrice !== it.broker.avgPrice,
    );
}

/** reconcile 경보 문구 — 수량 불일치만(평단 차이는 경보하지 않는다). */
export function quantityMismatchMessages(items: readonly HoldingsSyncItem[]): string[] {
    const out: string[] = [];
    for (const it of items) {
        if (it.action === 'update' && it.quantityMismatch) {
            out.push(
                `${it.symbol}: DB ${it.db.quantity}주 vs 브로커 ${it.brokerQuantity}주 (불일치)`,
            );
        } else if (it.action === 'close') {
            out.push(
                `${it.symbol}: DB ${it.db.quantity}주 vs 브로커 ${it.brokerQuantity}주 (불일치)`,
            );
        } else if (it.action === 'open') {
            out.push(`${it.symbol}: 브로커 ${it.broker.quantity}주 보유 but DB 포지션 없음`);
        }
    }
    return out;
}

/** 미리보기와 적용 사이에 상태가 바뀌지 않았는지 확인하는 해시. 순서 무관. */
export function hashSyncItems(items: readonly HoldingsSyncItem[]): string {
    const canonical = actionableItems(items)
        .map((it) => JSON.stringify(it))
        .sort()
        .join('\n');
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export class HoldingsSyncConflictError extends Error {
    constructor(symbol: string) {
        super(`${symbol} 포지션이 동기화 도중 바뀌었습니다`);
        this.name = 'HoldingsSyncConflictError';
    }
}

/**
 * 항목을 한 트랜잭션으로 적용한다. 갱신·닫기는 `status = 'open'`이고 **DB 값이 미리보기와
 * 같을 때만** 맞는다 — 그 사이 execute가 같은 포지션을 바꿨으면 0행 → 전체 롤백.
 */
export async function applyHoldingsSync(
    db: Db,
    items: readonly HoldingsSyncItem[],
): Promise<{ applied: number }> {
    const todo = actionableItems(items);
    await db.transaction(async (tx) => {
        for (const it of todo) {
            if (it.action === 'update') {
                const rows = await tx
                    .update(positions)
                    .set({
                        quantity: it.broker.quantity,
                        avgPrice: String(it.broker.avgPrice),
                    })
                    .where(
                        and(
                            eq(positions.id, it.positionId),
                            eq(positions.status, 'open'),
                            eq(positions.quantity, it.db.quantity),
                        ),
                    )
                    .returning({ id: positions.id });
                if (rows.length === 0) throw new HoldingsSyncConflictError(it.symbol);
            } else if (it.action === 'close') {
                const rows = await tx
                    .update(positions)
                    .set({ status: 'closed', closedAt: new Date(), closePrice: null })
                    .where(
                        and(
                            eq(positions.id, it.positionId),
                            eq(positions.status, 'open'),
                            eq(positions.quantity, it.db.quantity),
                        ),
                    )
                    .returning({ id: positions.id });
                if (rows.length === 0) throw new HoldingsSyncConflictError(it.symbol);
            } else {
                // 같은 심볼의 열린 포지션이 그 사이 생겼으면 `idx_positions_symbol_open`이 막는다.
                try {
                    await openPosition(tx, {
                        symbol: it.symbol,
                        side: 'long',
                        quantity: it.broker.quantity,
                        avgPrice: it.broker.avgPrice,
                        stopPrice: null,
                    });
                } catch (err) {
                    if ((err as { code?: string } | null)?.code === '23505') {
                        throw new HoldingsSyncConflictError(it.symbol);
                    }
                    throw err;
                }
            }
        }
    });
    return { applied: todo.length };
}
