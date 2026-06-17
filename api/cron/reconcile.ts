import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import {
    getPendingSubmittedOrders,
    updateOrderTracking,
    getOpenPositions,
    getConfigValue,
    getNotificationConfig,
    startCronRun,
    finishCronRun,
    insertCronDecisions,
} from '../../lib/db/queries.js';
import type { CronRunFinish } from '../../lib/db/queries.js';
import { sendErrorEmail } from '../../lib/notification/email.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { checkConsistency, autoRecoverFilledOrders } from '../../lib/db/recovery.js';
import { getOrder } from '../../lib/trading/orders.js';
import { cancelOrder, getHoldings } from '../../lib/trading/account.js';

/** Orders older than 30 minutes are considered timed out. */
const SUBMITTED_TIMEOUT_MS = 30 * 60 * 1000;

/** Quantity comparison tolerance for holdings reconciliation (fractional US shares). */
const HOLDINGS_QTY_EPSILON = 0.01;

async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Audit helpers — best-effort, never abort reconcile
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const runId = `reconcile-${crypto.randomUUID()}`;
    // getDb() early (cheap singleton) so the locked-out path can record a row
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    await safe(startCronRun(db, { runId, cronType: 'reconcile', startedAt }));

    let finishState: CronRunFinish | null = null;
    const results: Array<{
        id?: number;
        symbol?: string;
        action: string;
        reason?: string;
        detail?: unknown;
    }> = [];

    const LOCK_KEY = 'cron:reconcile:lock';
    // TTL < maxDuration(800s): a hung run holds the lock for its whole life (no mid-run expiry/overlap), and a killed fn's lock can't outlive it.
    const lockToken = await acquireLock(LOCK_KEY, 780);

    try {
        if (!lockToken) {
            finishState = { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'locked' });
        }
        const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

        // Reconcile alerts are system/safety notifications — gated on the dashboard
        // email toggle + the 'error' (시스템 오류) event. Off means off.
        const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
        const shouldEmail = makeEmailGate(emailNotif);
        const notifyError = (subject: string, body: string) =>
            shouldEmail('error')
                ? sendErrorEmail(subject, body).catch((e) => console.error('[email]', e))
                : Promise.resolve();

        const submitted = await getPendingSubmittedOrders(db);

        // Marks an order as timed out and emails an alert (urgent for sells).
        // Used both for orders with no broker id and when getOrder polling fails.
        const timeoutOrder = async (
            order: (typeof submitted)[number],
            age: number,
            detail?: unknown,
        ) => {
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

            await notifyError(subject, body);
            results.push({ id: order.id, symbol: order.symbol, action: 'timeout', detail });
        };

        let brokerPollFailures = 0;
        let holdingsCheckFailed = 0;
        let holdingsError: string | undefined;

        // Order resolution loop: broker-polling calls are skipped in dry_run — no real
        // orders are created, so tossOrderId rows won't exist and polling the live
        // broker from a simulated session would be a latent coupling. However, the
        // age-based timeout safety net (DB update + email) still runs in dry_run
        // because it touches no broker and is critical for sell-side safety.
        for (const order of submitted) {
            const age = Date.now() - new Date(order.submittedAt).getTime();
            const isTimedOut = age > SUBMITTED_TIMEOUT_MS;
            let brokerPollError: string | undefined;

            // First, try to resolve the order via the broker. Only fall back to
            // the age-based timeout path when there is no broker id or polling fails.
            // Skipped in dry_run: no real orders, no broker coupling.
            if (order.tossOrderId && tradingMode !== 'dry_run') {
                const detail = await getOrder(order.tossOrderId).catch((err) => {
                    brokerPollFailures++;
                    brokerPollError = err instanceof Error ? err.message : String(err);
                    console.warn('[reconcile] broker order polling failed', {
                        orderId: order.tossOrderId,
                        symbol: order.symbol,
                        error: brokerPollError,
                    });
                    return null;
                });
                if (detail) {
                    if (detail.status === 'FILLED') {
                        // Only auto-book a CLEAN FULL FILL: broker filled qty is a whole
                        // number equal (within epsilon) to the tracked intended integer
                        // quantity, AND a real fill price is present. autoRecoverFilledOrders
                        // books integer order.quantity, so this guarantees it only ever runs
                        // on orders whose actual fill equals that integer quantity.
                        const cleanFull =
                            detail.avgFilledPrice != null &&
                            Number.isInteger(order.quantity) &&
                            Math.abs(detail.filledQuantity - order.quantity) < 1e-6;
                        if (cleanFull) {
                            await updateOrderTracking(db, order.idempotencyKey, {
                                status: 'filled',
                                filledPrice: detail.avgFilledPrice ?? undefined,
                                resolvedAt: new Date(),
                            });
                            results.push({
                                id: order.id,
                                symbol: order.symbol,
                                action: 'resolved_filled',
                            });
                            continue;
                        }
                        // Short/fractional fill or missing fill price → do NOT auto-book
                        // (order_tracking.quantity is integer/intended). Route to manual review.
                        await updateOrderTracking(db, order.idempotencyKey, {
                            status: 'needs_review',
                            filledPrice: detail.avgFilledPrice ?? undefined,
                            resolvedAt: new Date(),
                        });
                        await notifyError(
                            `체결 수동확인 필요: ${order.symbol}`,
                            `주문 ${order.tossOrderId} FILLED 이나 체결수량(${detail.filledQuantity})이 의도수량(${order.quantity})과 불일치하거나 소수점. 수동 기록 필요.`,
                        );
                        results.push({
                            id: order.id,
                            symbol: order.symbol,
                            action: 'needs_review',
                        });
                        continue;
                    }

                    if (
                        detail.status === 'REJECTED' ||
                        detail.status === 'CANCEL_REJECTED' ||
                        detail.status === 'REPLACE_REJECTED'
                    ) {
                        await updateOrderTracking(db, order.idempotencyKey, {
                            status: 'rejected',
                            resolvedAt: new Date(),
                        });
                        results.push({
                            id: order.id,
                            symbol: order.symbol,
                            action: 'resolved_rejected',
                        });
                        continue;
                    }

                    if (detail.status === 'CANCELED') {
                        if (detail.filledQuantity > 0) {
                            // Partial fill then canceled — DO NOT auto-book (qty may be
                            // fractional/partial; order_tracking.quantity is integer/intended).
                            // Route to manual review.
                            await updateOrderTracking(db, order.idempotencyKey, {
                                status: 'needs_review',
                                resolvedAt: new Date(),
                            });
                            await notifyError(
                                `부분체결 후 취소 — 수동 확인: ${order.symbol}`,
                                `${order.side} 주문 ${order.tossOrderId} 가 ${detail.filledQuantity}주 부분체결 후 취소됨. 평균체결가 ${detail.avgFilledPrice}. trade/position 수동 기록 필요.`,
                            );
                            results.push({
                                id: order.id,
                                symbol: order.symbol,
                                action: 'needs_review',
                            });
                            continue;
                        }
                        await updateOrderTracking(db, order.idempotencyKey, {
                            status: 'canceled',
                            resolvedAt: new Date(),
                        });
                        results.push({
                            id: order.id,
                            symbol: order.symbol,
                            action: 'resolved_canceled',
                        });
                        continue;
                    }

                    if (detail.status === 'PARTIAL_FILLED') {
                        if (isTimedOut) {
                            // Remainder not filling — cancel it, then route the filled
                            // portion to manual review (don't auto-book partial fills).
                            await cancelOrder(order.tossOrderId).catch((e) =>
                                console.error('[cancel]', e),
                            );
                            await updateOrderTracking(db, order.idempotencyKey, {
                                status: 'needs_review',
                                resolvedAt: new Date(),
                            });
                            await notifyError(
                                `부분체결 타임아웃 — 수동 확인: ${order.symbol}`,
                                `${order.side} 주문 ${order.tossOrderId} 가 30분 경과 부분체결(${detail.filledQuantity}주 @ ${detail.avgFilledPrice}). 잔량 취소 시도함. 수동 기록 필요.`,
                            );
                            results.push({
                                id: order.id,
                                symbol: order.symbol,
                                action: 'needs_review',
                            });
                            continue;
                        }
                        // Within window — leave 'partial', wait.
                        results.push({
                            id: order.id,
                            symbol: order.symbol,
                            action: 'waiting_partial',
                        });
                        continue;
                    }

                    // PENDING / PENDING_CANCEL / PENDING_REPLACE / REPLACED — still in-flight.
                    if (isTimedOut) {
                        await cancelOrder(order.tossOrderId).catch((e) =>
                            console.error('[cancel]', e),
                        );
                        await timeoutOrder(order, age);
                        continue;
                    }
                    results.push({ id: order.id, symbol: order.symbol, action: 'waiting' });
                    continue;
                }
                // detail null (getOrder failed) → fall through to the timeout fallback below.
            }

            // No tossOrderId OR getOrder failed OR dry_run: age-based timeout fallback.
            if (isTimedOut) {
                await timeoutOrder(
                    order,
                    age,
                    brokerPollError
                        ? {
                              brokerPoll: {
                                  status: 'failed',
                                  orderId: order.tossOrderId,
                                  error: brokerPollError,
                              },
                          }
                        : undefined,
                );
            } else {
                results.push({
                    id: order.id,
                    symbol: order.symbol,
                    action: 'waiting',
                    ...(brokerPollError
                        ? {
                              reason: 'broker_poll_failed',
                              detail: {
                                  brokerPoll: {
                                      status: 'failed',
                                      orderId: order.tossOrderId,
                                      error: brokerPollError,
                                  },
                              },
                          }
                        : {}),
                });
            }
        }

        // Auto-recover filled orders without matching trades
        const recovery = await autoRecoverFilledOrders(db);
        if (recovery.recovered > 0 || recovery.failed > 0) {
            await notifyError(
                `자동 복구 결과: ${recovery.recovered}건 성공, ${recovery.failed}건 실패`,
                recovery.details.join('\n'),
            );
        }

        // DB consistency check
        const consistency = await checkConsistency(db);
        if (consistency.alerts.length > 0) {
            await notifyError(
                `DB 정합성 경고 (${consistency.alerts.length}건)`,
                consistency.alerts.join('\n'),
            );
        }

        // Holdings reconciliation — compare broker holdings vs DB open positions.
        // Skipped in dry_run: DB positions are simulated, so comparing against the real
        // broker account would produce constant false-positive alerts.
        // Filter to US-only: the system trades only US equities; Korean/manual holdings
        // would cause constant false-positive "broker holding without DB position" alerts.
        let holdingsMismatchCount = 0;
        if (tradingMode !== 'dry_run') {
            const holdings = await getHoldings().catch((err) => {
                holdingsCheckFailed = 1;
                holdingsError = err instanceof Error ? err.message : String(err);
                console.warn('[reconcile] holdings check failed', { error: holdingsError });
                return null;
            });
            if (holdings) {
                const usHoldings = holdings.filter(
                    (h) => h.currency === 'USD' || h.marketCountry === 'US',
                );
                const openPositions = await getOpenPositions(db);
                const mismatches: string[] = [];
                const brokerBySymbol = new Map(usHoldings.map((h) => [h.symbol, h]));

                for (const pos of openPositions) {
                    const dbQty = Number(pos.quantity);
                    const broker = brokerBySymbol.get(pos.symbol);
                    const brokerQty = broker ? broker.quantity : 0;
                    if (Math.abs(dbQty - brokerQty) > HOLDINGS_QTY_EPSILON) {
                        mismatches.push(
                            `${pos.symbol}: DB ${dbQty}주 vs 브로커 ${brokerQty}주 (불일치)`,
                        );
                    }
                }

                // Broker holdings with no matching open DB position.
                const dbSymbols = new Set(openPositions.map((p) => p.symbol));
                for (const h of usHoldings) {
                    if (h.quantity > HOLDINGS_QTY_EPSILON && !dbSymbols.has(h.symbol)) {
                        mismatches.push(
                            `${h.symbol}: 브로커 ${h.quantity}주 보유 but DB 포지션 없음`,
                        );
                    }
                }

                holdingsMismatchCount = mismatches.length;
                if (mismatches.length > 0) {
                    await notifyError(
                        `보유 정합성 불일치 (${mismatches.length}건)`,
                        mismatches.join('\n'),
                    );
                }
            }
        }

        const actionsByType = results.reduce<Record<string, number>>((acc, r) => {
            acc[r.action] = (acc[r.action] ?? 0) + 1;
            return acc;
        }, {});
        finishState = {
            status: 'completed',
            outcome: 'completed',
            summary: {
                processed: results.length,
                recovered: recovery.recovered,
                recoveryFailed: recovery.failed,
                consistencyAlerts: consistency.alerts.length,
                holdingsMismatches: holdingsMismatchCount,
                brokerPollFailures,
                holdingsCheckFailed,
                ...(holdingsError ? { holdingsError } : {}),
                actionsByType,
            },
            ...elapsed(),
        };
        return Response.json({
            processed: results.length,
            results,
            recovery: {
                recovered: recovery.recovered,
                failed: recovery.failed,
            },
            consistency: {
                filledOrdersWithoutTrades: consistency.filledOrdersWithoutTrades,
                alertCount: consistency.alerts.length,
            },
            holdings: {
                mismatchCount: holdingsMismatchCount,
                ...(holdingsCheckFailed > 0 ? { checkFailed: true } : {}),
            },
            brokerPoll: {
                failureCount: brokerPollFailures,
            },
        });
    } catch (e) {
        finishState = {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            ...elapsed(),
        };
        throw e;
    } finally {
        await releaseLock(LOCK_KEY, lockToken).catch((e) => console.error('[lock-release]', e));
        if (finishState) {
            await safe(finishCronRun(db, runId, finishState));
            await safe(
                insertCronDecisions(
                    db,
                    runId,
                    'reconcile',
                    results.map((r) => ({
                        symbol: r.symbol,
                        action: r.action,
                        reason: r.reason,
                        detail: r.detail,
                    })),
                ),
            );
        }
    }
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
