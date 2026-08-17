import crypto from 'node:crypto';
import { isAuthenticated } from '../../_lib/auth.js';
import { getDb } from '../../_lib/db.js';
import {
    closePosition,
    createOrderTracking,
    getConfigValue,
    getOpenPositions,
    insertTrade,
    updateOrderTracking,
} from '../../../lib/db/queries.js';
import { realizedPnlForSell } from '../../../lib/strategy/pnl.js';
import { executeSellOrder } from '../../../lib/trading/orders.js';
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
     * `auto`에서는 브로커에 실제 매도 주문을 낸다.
     *
     * 종전에는 이 엔드포인트가 DB만 닫고 브로커를 전혀 호출하지 않았다. 그러면 실계좌에는
     * 주식이 그대로 남는데 `getOpenPositions`에서는 사라지므로, execute cron의 재평가·손절·
     * 강제청산 어디에도 도달하지 못하는 **유령 보유**가 된다. reconcile의 보유 비교가 10분마다
     * 메일을 보내는 것이 유일한 신호였고, 자동 복구는 없었다.
     *
     * dry_run / semi_auto는 종전대로 DB만 기록한다 — 전자는 시뮬레이션이고, 후자에서 이
     * 버튼은 운영자가 이미 내린 결정이므로 승인 대기열을 다시 거칠 이유가 없다(주문은
     * 브로커로 나가지 않는다는 점에서 dry_run과 같다).
     */
    let clientOrderId: string | undefined;
    if (tradingMode === 'auto') {
        clientOrderId = crypto.randomUUID();
        const idempotencyKey = `manual-close-${id}-${Date.now()}`;
        await createOrderTracking(db, {
            idempotencyKey,
            clientOrderId,
            symbol: position.symbol,
            side: 'sell',
            quantity: position.quantity,
            status: 'submitted',
        });

        let outcome;
        try {
            outcome = await executeSellOrder(position.symbol, position.quantity, clientOrderId);
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
        await updateOrderTracking(db, idempotencyKey, {
            tossOrderId: outcome.orderId || undefined,
            status: 'filled',
            filledPrice: closePrice,
            resolvedAt: new Date(),
        });
    }

    // Close position + record trade atomically
    try {
        await db.transaction(async (tx) => {
            const closed = await closePosition(tx, id, closePrice);
            if (!closed) {
                throw new AlreadyClosedError();
            }
            await insertTrade(tx, {
                symbol: position.symbol,
                side: 'sell',
                orderType: 'market',
                quantity: position.quantity,
                price: closePrice,
                executedAt: new Date(),
                reason: '수동 청산',
                // 실제 모드를 기록한다. 종전에는 `'semi_auto'` 하드코딩이라 dry_run에서 누른
                // 청산까지 `getTodayRealizedPnl`에 섞여 실계좌 손실 차단기를 오염시켰다.
                mode: tradingMode,
                clientOrderId,
                realizedPnl: realizedPnlForSell(
                    closePrice,
                    Number(position.avgPrice),
                    position.quantity,
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
