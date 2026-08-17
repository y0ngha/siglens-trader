import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import { acquireLockDetailed, releaseLock } from '../../lib/lock.js';
import {
    getPendingSubmittedOrders,
    updateOrderTracking,
    getOpenPositions,
    getConfigValue,
    getNotificationConfig,
    enqueueNotification,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
    insertCronDecisions,
} from '../../lib/db/queries.js';
import type { CronRunFinish } from '../../lib/db/queries.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { createEmailDispatcher } from '../../lib/notification/dispatch.js';
import { checkConsistency, autoRecoverFilledOrders } from '../../lib/db/recovery.js';
import { getOrder } from '../../lib/trading/orders.js';
import { cancelOrder, getHoldings } from '../../lib/trading/account.js';
import { isFinitePositive } from '../../lib/validation.js';
import { isUsTradingDay } from '@y0ngha/siglens-core';

/** Orders older than 30 minutes are considered timed out. */
const SUBMITTED_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 취소가 계속 실패하는 주문을 사람에게 넘기는 나이 상한 (6시간).
 *
 * 취소 성공을 확인하기 전에는 종료 상태로 넘기지 않는 것이 원칙이지만, 브로커 조회와
 * 취소가 **같은 이유로** 계속 실패하면(엔드포인트 변경, 계정 잠금) 그 행은 영원히
 * in-flight로 남아 그 심볼의 신규 매수를 무기한 막고 10분마다 메일을 보낸다.
 * 한 세션(6.5시간)에 못 풀면 자동화가 할 수 있는 일은 없다.
 */
const CANCEL_RETRY_LIMIT_MS = 6 * 60 * 60 * 1000;

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

    // Finalize any audit rows stuck in 'running' past the stale threshold (a
    // prior invocation that timed out before writing its finish row). Best-effort.
    await safe(finalizeStaleCronRuns(db, startedAt));
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
    const lock = await acquireLockDetailed(LOCK_KEY, 780);
    const lockToken = lock.token;

    try {
        if (!lockToken) {
            // 경합과 Redis 장애를 가른다 — 후자는 감시망에 걸려야 한다.
            finishState =
                lock.reason === 'unavailable'
                    ? {
                          status: 'error',
                          outcome: 'locked',
                          error: 'lock backend unavailable',
                          ...elapsed(),
                      }
                    : { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'locked' });
        }
        const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';

        // Reconcile alerts are system/safety notifications — gated on the dashboard
        // email toggle + the 'error' (시스템 오류) event. Off means off.
        const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
        const shouldEmail = makeEmailGate(emailNotif);
        const dispatcher = createEmailDispatcher({
            gate: shouldEmail,
            to: emailNotif?.target,
            enqueue: (row) => enqueueNotification(db, row),
        });
        const notifyError = (subject: string, body: string) =>
            dispatcher.notifyError(subject, body).catch((e) => console.error('[email]', e));

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

        /**
         * 취소 실패 처리. 기본은 **상태 유지 + 다음 실행 재시도** — 살아 있을지 모르는
         * 주문을 종료 상태로 넘기지 않는다. 다만 `CANCEL_RETRY_LIMIT_MS`를 넘기면
         * `needs_review`로 종결한다: 그때까지 안 풀린 것은 자동화가 풀 수 없고, 영원히
         * in-flight로 두면 그 심볼의 신규 매수가 무기한 막히고 메일이 10분마다 나간다.
         */
        const handleCancelFailure = async (order: (typeof submitted)[number], age: number) => {
            const giveUp = age > CANCEL_RETRY_LIMIT_MS;
            if (giveUp) {
                await updateOrderTracking(db, order.idempotencyKey, {
                    status: 'needs_review',
                    resolvedAt: new Date(),
                });
            }
            await notifyError(
                `주문 취소 실패: ${order.symbol}`,
                giveUp
                    ? `${order.side} 주문 ${order.tossOrderId} 취소가 ${Math.round(age / 3_600_000)}시간째 실패해 수동 확인(needs_review)으로 넘깁니다. 브로커 계좌를 직접 확인하세요.`
                    : `${order.side} 주문 ${order.tossOrderId} 취소에 실패했습니다. 상태를 유지하고 다음 실행에서 다시 시도합니다.`,
            );
            results.push({
                id: order.id,
                symbol: order.symbol,
                action: giveUp ? 'needs_review' : 'cancel_failed',
            });
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
                            // `!= null`만으로는 파싱 실패로 들어온 0이 통과해 체결가 0이
                            // 기록되고, 그 매도 전량이 손실로 잡혀 다음 execute 틱에 일일
                            // 손실 한도가 터진다(= 전 종목 강제청산).
                            isFinitePositive(detail.avgFilledPrice) &&
                            Number.isInteger(order.quantity) &&
                            Math.abs(detail.filledQuantity - order.quantity) < 1e-6;
                        if (cleanFull) {
                            await updateOrderTracking(db, order.idempotencyKey, {
                                status: 'filled',
                                filledPrice: detail.avgFilledPrice ?? undefined,
                                resolvedAt: new Date(),
                            });
                            // A5: notify the operator of the late-confirmed fill.
                            // Gated on 'trade_executed' so the dashboard checkbox is respected.
                            await dispatcher
                                .notifyTradeExecuted({
                                    symbol: order.symbol,
                                    side: order.side,
                                    quantity: order.quantity,
                                    price: detail.avgFilledPrice!,
                                    reason: `Reconcile 확인 (${order.idempotencyKey})`,
                                    mode: tradingMode,
                                })
                                .catch((e) => console.error('[email]', e));
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
                            // 취소가 실제로 됐는지 확인한 뒤에만 종료 상태로 넘긴다.
                            // 실패했는데 `needs_review`(종료)로 적으면 이 주문은 다시 조회되지
                            // 않는데, 브로커에서는 잔량이 살아 있다가 나중에 체결될 수 있다.
                            // 그러면 DB는 영원히 모르고, 다음 execute 틱은 in-flight가 없다고
                            // 보고 같은 포지션에 두 번째 매도를 낸다.
                            const canceled = await cancelOrder(order.tossOrderId)
                                .then(() => true)
                                .catch((e) => {
                                    console.error('[cancel]', e);
                                    return false;
                                });
                            if (!canceled) {
                                await notifyError(
                                    `잔량 취소 실패: ${order.symbol}`,
                                    `${order.side} 주문 ${order.tossOrderId} 부분체결 잔량 취소에 실패했습니다. 상태를 유지하고 다음 실행에서 다시 시도합니다. 브로커에서 직접 확인이 필요할 수 있습니다.`,
                                );
                                results.push({
                                    id: order.id,
                                    symbol: order.symbol,
                                    action: 'cancel_failed',
                                });
                                continue;
                            }
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
                        // 위와 같은 이유 — 취소 실패는 종료 상태로 넘기지 않는다.
                        const canceled = await cancelOrder(order.tossOrderId)
                            .then(() => true)
                            .catch((e) => {
                                console.error('[cancel]', e);
                                return false;
                            });
                        if (!canceled) {
                            await handleCancelFailure(order, age);
                            continue;
                        }
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
                // 조회가 실패했을 뿐 브로커에는 주문이 **살아 있을 수 있다.** 취소를 확인하지
                // 않고 `timeout`(종료 상태)으로 확정하면 그 주문은 in-flight 집합에서 빠져
                // 다시 조회되지 않고, 나중에 체결되면 장부에 영영 안 잡힌다. 그리고 다음
                // execute 틱은 in-flight가 없다고 보고 같은 심볼에 두 번째 주문을 낸다.
                // PENDING 분기가 이미 지키는 규칙(취소 성공 확인 후에만 종료 상태)을
                // 브로커 조회 실패 경로에도 적용한다.
                if (order.tossOrderId && tradingMode !== 'dry_run') {
                    const canceled = await cancelOrder(order.tossOrderId)
                        .then(() => true)
                        .catch((e) => {
                            console.error('[cancel]', e);
                            return false;
                        });
                    if (!canceled) {
                        await handleCancelFailure(order, age);
                        continue;
                    }
                }
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
        //
        // **휴장일에는 처리할 주문이 있을 때만 비교한다.**
        //
        // reconcile은 세션 게이트를 두지 않는다 — 다른 cron과 달리 이 잡의 일은 시장 활동이
        // 아니라 주문 사후 처리이고, 금요일 오후에 낸 주문이 연휴 내내 미체결로 떠 있으면
        // 그 타임아웃을 처리할 주체가 여기밖에 없다. 그래서 휴장일에도 10분마다 돈다.
        //
        // 그런데 **보유 비교만은 시장이 닫힌 날 반복할 이유가 없다.** 브로커 잔고는 체결로만
        // 바뀌는데 휴장일에는 체결이 없으므로, 처리할 주문도 복구할 체결도 없으면 39번을
        // 돌아도 답이 같다. 그 39번이 전부 브로커 API 호출이다.
        //
        // 안전성: 직전 세션의 reconcile 실행들이 이미 같은 비교를 했고 다음 개장일에 다시
        // 한다. 이 스킵이 늦추는 것은 "휴장 구간 동안의 불일치 통지"뿐인데, 그 구간에는
        // 불일치를 만들 사건 자체가 없다. 반대로 주문이 남아 있거나 이번 실행이 무언가를
        // 복구했다면 잔고가 움직였을 수 있으므로 그때는 비교한다.
        const marketClosedToday = !isUsTradingDay(startedAt);
        // 복구가 **실패**했다는 것은 장부가 이미 어긋나 있다는 뜻이므로, 그때는 조용한
        // 휴장일이어도 보유를 대조한다.
        const nothingToReconcile =
            submitted.length === 0 && recovery.recovered === 0 && recovery.failed === 0;
        const skipHoldingsCheck = marketClosedToday && nothingToReconcile;

        let holdingsMismatchCount = 0;
        if (tradingMode !== 'dry_run' && !skipHoldingsCheck) {
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
                ...(skipHoldingsCheck ? { holdingsCheckSkipped: 'market_closed' } : {}),
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
