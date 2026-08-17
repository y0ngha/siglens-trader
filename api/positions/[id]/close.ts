import crypto from 'node:crypto';
import { isAuthenticated } from '../../_lib/auth.js';
import { getDb } from '../../_lib/db.js';
import {
    closePosition,
    createOrderTracking,
    getConfigValue,
    getOpenPositions,
    getPendingSubmittedOrders,
    insertTrade,
    reducePositionQuantity,
    updateOrderTracking,
} from '../../../lib/db/queries.js';
import { realizedPnlForSell } from '../../../lib/strategy/pnl.js';
import { executeSellOrder } from '../../../lib/trading/orders.js';
import { getSellableQuantity } from '../../../lib/trading/account.js';
import { fetchLivePrice } from '../../../lib/data/live-price.js';
import { isFinitePositive } from '../../../lib/validation.js';

class AlreadyClosedError extends Error {
    constructor() {
        super('Position already closed');
        this.name = 'AlreadyClosedError';
    }
}

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/');
    // URL: /api/positions/:id/close -> segments = ['', 'api', 'positions', ':id', 'close']
    const id = Number(segments[segments.length - 2]);

    if (Number.isNaN(id)) {
        return Response.json({ error: 'Invalid position ID' }, { status: 400 });
    }

    const db = getDb();

    // Find the position to get details for the trade record
    const positions = await getOpenPositions(db);
    const position = positions.find((p) => p.id === id);

    if (!position) {
        return Response.json({ error: 'Position not found' }, { status: 404 });
    }

    const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

    // Accept optional price from request body; fall back to the live quote, then avgPrice.
    // 종전에는 곧바로 avgPrice로 떨어져 **실현 손익이 항상 0**으로 기록됐다.
    const body = await req.json().catch(() => ({}));
    const requestedPrice = (body as Record<string, unknown>)?.price;
    const livePrice = isFinitePositive(requestedPrice)
        ? requestedPrice
        : ((await fetchLivePrice(position.symbol).catch(() => null)) ?? 0);
    let closePrice = isFinitePositive(livePrice) ? livePrice : Number(position.avgPrice);

    /**
     * `dry_run`이 아니면 브로커에 실제 매도 주문을 낸다.
     *
     * 종전에는 이 엔드포인트가 DB만 닫고 브로커를 전혀 호출하지 않았다. 그러면 실계좌에는
     * 주식이 그대로 남는데 `getOpenPositions`에서는 사라지므로, execute cron의 재평가·손절·
     * 강제청산 어디에도 도달하지 못하는 **유령 보유**가 된다. reconcile의 보유 비교가 10분마다
     * 메일을 보내는 것이 유일한 신호였고, 자동 복구는 없었다.
     *
     * `semi_auto`도 실주문이다 — `api/approve/[id].ts`의 `shouldPlaceLiveOrder`가
     * `semi_auto || auto`라 이 모드의 포지션은 **실계좌에 실재한다**. 종전 조건
     * (`=== 'auto'`)은 그 사실과 어긋나 semi_auto에 유령 보유를 그대로 남겨 뒀다.
     * `dry_run`만 시뮬레이션이므로 DB만 기록한다.
     */
    // `{ force: true }` — 브로커 주문 없이 DB 포지션만 닫는 관리자 경로.
    //
    // 브로커에는 이미 없는데 DB에만 남은 행(과거 유령 보유, 수동 매도)을 정리할 방법이
    // 있어야 한다. 아래 매도가능 수량 가드가 그 행을 영구히 닫지 못하게 만들기 때문에
    // 명시적 탈출구를 둔다. 기본은 false — 실수로 장부만 닫는 일이 없게.
    const forceDbOnly = (body as Record<string, unknown>)?.force === true;
    const placesLiveOrder = tradingMode !== 'dry_run' && !forceDbOnly;
    let clientOrderId: string | undefined;
    let sellQuantity = position.quantity;
    /** 체결이 확정된 주문의 멱등키. 트랜잭션 안에서 `filled`로 확정하기 위해 들고 나온다. */
    let filledOrderKey: string | undefined;
    if (placesLiveOrder) {
        // 같은 심볼의 매도가 이미 브로커에 떠 있으면 두 번째 전량 매도를 내지 않는다 —
        // 버튼 더블클릭이나 미체결 상태의 재클릭이 그대로 네이키드 숏이 된다.
        //
        // 판정 범위는 execute의 **매도** 가드와 같은 세 상태로 좁힌다. `error`(결말 미확정)를
        // 포함하면 브로커 조회가 막힌 30분 동안 수동 청산이 통째로 불가능해진다 — 진입을
        // 막는 것과 달리 청산을 막는 것은 원칙 7 위반이다. 매수 쪽만 `error`를 센다.
        const inflight = await getPendingSubmittedOrders(db);
        if (
            inflight.some(
                (o) =>
                    o.symbol === position.symbol &&
                    o.side === 'sell' &&
                    ['submitted', 'pending', 'partial'].includes(o.status),
            )
        ) {
            return Response.json(
                {
                    error: `${position.symbol} 매도 주문이 이미 진행 중입니다. 체결/취소가 확정된 뒤 다시 시도하세요.`,
                },
                { status: 409 },
            );
        }

        // 브로커 보유를 넘는 수량을 주문하지 않는다(execute의 매도 경로와 동일한 클램프).
        // 읽지 못하면(`null`) 가드를 끄고 그대로 낸다 — 청산 fail-open.
        const sellable = await getSellableQuantity(position.symbol).catch(() => null);
        if (sellable != null) {
            const clamped = Math.min(sellQuantity, Math.floor(sellable));
            if (clamped <= 0) {
                return Response.json(
                    {
                        error: `${position.symbol} 매도 가능 수량이 없습니다 (브로커 보유 ${sellable}). 브로커에 실제로 없는 포지션이면 { "force": true }로 장부만 닫으세요.`,
                    },
                    { status: 409 },
                );
            }
            sellQuantity = clamped;
        }

        clientOrderId = crypto.randomUUID();
        const idempotencyKey = `manual-close-${id}-${Date.now()}`;
        await createOrderTracking(db, {
            idempotencyKey,
            clientOrderId,
            symbol: position.symbol,
            side: 'sell',
            quantity: sellQuantity,
            status: 'submitted',
        });

        let outcome;
        try {
            outcome = await executeSellOrder(position.symbol, sellQuantity, clientOrderId);
        } catch (err) {
            await updateOrderTracking(db, idempotencyKey, {
                status: 'error',
                resolvedAt: new Date(),
            }).catch(() => {});
            return Response.json(
                { error: `브로커 주문 실패: ${err instanceof Error ? err.message : String(err)}` },
                { status: 502 },
            );
        }

        if (outcome.status === 'rejected' || outcome.status === 'canceled') {
            await updateOrderTracking(db, idempotencyKey, {
                tossOrderId: outcome.orderId || undefined,
                status: outcome.status,
                resolvedAt: new Date(),
            });
            return Response.json(
                { error: `브로커가 주문을 거부했습니다: ${outcome.rejectReason ?? '사유 없음'}` },
                { status: 502 },
            );
        }

        // 체결이 확정되지 않았으면 DB 포지션을 닫지 않는다. 닫아 버리면 미체결 주문이
        // 살아 있는 채로 포지션이 사라져 위에서 말한 유령 보유가 그대로 재현된다.
        // reconcile이 확정하고 `autoRecoverFilledOrders`가 장부를 맞춘다.
        if (outcome.status !== 'filled') {
            await updateOrderTracking(db, idempotencyKey, {
                tossOrderId: outcome.orderId || undefined,
                status: outcome.status,
            });
            return Response.json(
                {
                    accepted: true,
                    status: outcome.status,
                    message: '주문이 접수되었습니다. 체결 확정은 reconcile이 처리합니다.',
                },
                { status: 202 },
            );
        }

        if (isFinitePositive(outcome.avgFilledPrice)) closePrice = outcome.avgFilledPrice;
        // `filled` 기록은 아래 트랜잭션 안에서 한다. 여기서 먼저 쓰면 뒤이은 booking이
        // 경합으로 롤백됐을 때 "trade 없는 filled" 행이 남고, reconcile의 자동 복구가
        // 그 행을 근거로 **다른** 포지션을 건드린다. 다른 모든 체결 경로와 같은 규칙.
        await updateOrderTracking(db, idempotencyKey, {
            tossOrderId: outcome.orderId || undefined,
        });
        filledOrderKey = idempotencyKey;
    }

    // Close position + record trade atomically
    try {
        await db.transaction(async (tx) => {
            // 브로커 클램프로 보유보다 적게 팔렸으면 포지션을 닫지 않고 줄인다.
            const applied =
                sellQuantity >= position.quantity
                    ? await closePosition(tx, id, closePrice)
                    : await reducePositionQuantity(tx, id, sellQuantity);
            if (!applied) {
                throw new AlreadyClosedError();
            }
            if (filledOrderKey) {
                await updateOrderTracking(tx, filledOrderKey, {
                    status: 'filled',
                    filledPrice: closePrice,
                    resolvedAt: new Date(),
                });
            }
            await insertTrade(tx, {
                symbol: position.symbol,
                side: 'sell',
                orderType: 'market',
                quantity: sellQuantity,
                price: closePrice,
                executedAt: new Date(),
                reason: forceDbOnly ? '수동 청산 (강제 — 브로커 주문 없음)' : '수동 청산',
                // 실제 모드를 기록한다. 종전에는 `'semi_auto'` 하드코딩이라 dry_run에서 누른
                // 청산까지 `getTodayRealizedPnl`에 섞여 실계좌 손실 차단기를 오염시켰다.
                mode: tradingMode,
                clientOrderId,
                realizedPnl: realizedPnlForSell(
                    closePrice,
                    Number(position.avgPrice),
                    sellQuantity,
                ),
            });
        });
    } catch (err) {
        if (err instanceof AlreadyClosedError) {
            return Response.json({ error: 'Position already closed' }, { status: 409 });
        }
        throw err;
    }

    return Response.json({ success: true });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const POST = handler;
