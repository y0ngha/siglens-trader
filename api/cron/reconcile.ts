// TODO: Toss API 오픈 후 — getOrderStatus()로 submitted 주문의 실제 broker 상태 조회
// TODO: 체결 확인 시 position/trade 자동 생성, 미체결 시 cancelOrder() 호출
// TODO: getBalances()로 broker 잔고와 DB positions 비교 → 불일치 시 알림
import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import { acquireLock, releaseLock } from '../../lib/lock';
import { getPendingSubmittedOrders, updateOrderTracking } from '../../lib/db/queries';
import { sendErrorEmail } from '../../lib/notification/email';
import { checkConsistency } from '../../lib/db/recovery';

/** Orders older than 30 minutes are considered timed out. */
const SUBMITTED_TIMEOUT_MS = 30 * 60 * 1000;

export default async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    const LOCK_KEY = 'cron:reconcile:lock';
    let lockAcquired = false;
    const locked = await acquireLock(LOCK_KEY, 300); // 5 min TTL
    if (!locked) {
        return Response.json({ skipped: true, reason: 'locked' });
    }
    lockAcquired = true;

    try {
        const db = getDb();
        const submitted = await getPendingSubmittedOrders(db);
        const results: Array<{ id: number; symbol: string; action: string }> = [];

        for (const order of submitted) {
            const age = Date.now() - new Date(order.submittedAt).getTime();

            if (age > SUBMITTED_TIMEOUT_MS) {
                await updateOrderTracking(db, order.idempotencyKey, {
                    status: 'timeout',
                    resolvedAt: new Date(),
                });

                const isUrgent = order.side === 'sell';
                const subject = isUrgent
                    ? `[긴급] 매도 주문 타임아웃: ${order.symbol}`
                    : `미체결 주문 타임아웃: ${order.symbol}`;

                const body = isUrgent
                    ? `${order.symbol} sell ${order.quantity}주 주문이 ${Math.round(age / 60000)}분째 미체결 상태입니다. 브로커에 포지션이 남아 있을 수 있습니다. 즉시 수동 확인이 필요합니다.\nIdempotency Key: ${order.idempotencyKey}`
                    : `${order.symbol} ${order.side} ${order.quantity}주 주문이 ${Math.round(age / 60000)}분째 미체결 상태입니다. 수동 확인이 필요합니다.\nIdempotency Key: ${order.idempotencyKey}`;

                await sendErrorEmail(subject, body).catch((e) => console.error('[email]', e));

                results.push({ id: order.id, symbol: order.symbol, action: 'timeout' });
            } else {
                results.push({ id: order.id, symbol: order.symbol, action: 'waiting' });
            }
        }

        // DB consistency check
        const consistency = await checkConsistency(db);
        if (consistency.alerts.length > 0) {
            await sendErrorEmail(
                `DB 정합성 경고 (${consistency.alerts.length}건)`,
                consistency.alerts.join('\n'),
            ).catch((e) => console.error('[email]', e));
        }

        return Response.json({
            processed: results.length,
            results,
            consistency: {
                filledOrdersWithoutTrades: consistency.filledOrdersWithoutTrades,
                alertCount: consistency.alerts.length,
            },
        });
    } finally {
        if (lockAcquired) await releaseLock(LOCK_KEY);
    }
}
