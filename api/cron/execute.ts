import crypto from 'node:crypto';
import {
    isEtRegularSessionOpen,
    isUsTradingDay,
    minutesUntilUsMarketClose,
} from '@y0ngha/siglens-core';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import { getAvailableCashUsd } from '../_lib/cash.js';
import { readDryRunCostBps, readMrParams } from '../_lib/mr-config.js';
import {
    getEnabledWatchlist,
    getConfigValue,
    getOpenPositions,
    getPendingOrders,
    getTodayTradeCount,
    getTodayInflightOrderCount,
    getTodayRealizedPnl,
    getNeedsReviewSymbols,
    expireOldPendingOrders,
    getPendingSubmittedOrders,
    getNotificationConfig,
    enqueueNotification,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
    insertCronDecisions,
    hasDecisionPhaseSince,
    setPositionStopPrice,
    getSymbolsSoldSince,
} from '../../lib/db/queries.js';
import type { CronDecisionInput, CronRunFinish } from '../../lib/db/queries.js';
import {
    DEFAULT_EXECUTE_INTERVAL_MIN,
    isExecuteTick,
    parseExecuteInterval,
} from '../../lib/strategy/execute-interval.js';
import {
    ATR_PERIOD,
    evaluateRuleExit,
    holdDays,
    isEntrySignal,
    isStopHit,
    rankSignals,
    readRegime,
    readSymbol,
    stopPriceFor,
    wilderAtr,
    type DailyBar,
    type RegimeReading,
    type SymbolReading,
} from '../../lib/strategy/mean-reversion.js';
import { todayUnrealizedChange } from '../../lib/strategy/daily-loss.js';
import { planEntry } from '../../lib/strategy/trade-plan.js';
import {
    etDateOf,
    etDayStart,
    etMinutesOfDay,
    fetchDailyBars,
} from '../../lib/analysis/daily-bars.js';
import { fetchLivePriceDetail } from '../../lib/data/live-price.js';
import type { LivePriceDetail } from '../../lib/data/live-price.js';
import { isUsMarketOpen } from '../../lib/trading/account.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { createEmailDispatcher } from '../../lib/notification/dispatch.js';
import { acquireLockDetailed, claimOnce, releaseLock } from '../../lib/lock.js';
import { safeNumber } from '../../lib/validation.js';
import { executeEntry, executeExit, type OrderOutcome, type TradingMode } from './_orders.js';

/**
 * execute 크론 — 일봉 RSI(2) 눌림매수(docs/specs/2026-09-24-daily-mean-reversion-design.md).
 *
 * 한 틱은 두 단계다(§4.1):
 * - **위험 단계**(매 틱): 킬 스위치, 일일 거래·손실 한도, 재난 손절, 비어 있는 손절가 채우기.
 * - **판단 단계**(장 마감 20분 전 창의 첫 틱, 하루 1회): 규칙 청산(MA5 회복·보유 기간)과 진입.
 *
 * 주문 실행은 `_orders.ts`가 한다 — 여기서는 무엇을 얼마나 할지만 정한다.
 */

type ExecuteDecision = CronDecisionInput & { symbol?: string; score: number };

/** 한 실행이 새 작업을 시작할 수 있는 마지막 시점(시작 + 900초). 락 TTL 1800초 안에 끝나게 한다. */
const RUN_DEADLINE_MS = 900_000;
const LOCK_TTL_SEC = 1800;
const LOCK_KEY = 'cron:execute:lock';

/** 판단 창 — 마감 전 이 분 안. 반일장이면 마감 시각이 당겨져 창도 같이 당겨진다(§4.1). */
export const DECISION_WINDOW_MIN = 20;

/** 국면 필터의 기준 지수. 관심종목에 없어도 판단 틱마다 조회한다. */
const REGIME_SYMBOL = 'SPY';

/** 같은 ET 날짜에 같은 경보 메일을 한 번만 — 여러 날 보유하는 전략에서는 매 틱 메일이 몇 시간씩 쌓인다(§4.5). */
const DAILY_MAIL_TTL_SEC = 86_400;

/**
 * 지금이 판단 창 안인가 — 거래일이고 마감까지 0분 초과 `DECISION_WINDOW_MIN`분 이하.
 * `minutesUntilUsMarketClose`는 공휴일에만 0을 주고 주말에는 평일 마감 시각을 기준으로 센다 —
 * 그래서 거래일 여부를 따로 본다.
 */
export function isInDecisionWindow(now: Date): boolean {
    if (!isUsTradingDay(now)) return false;
    const left = minutesUntilUsMarketClose(now, etMinutesOfDay(now));
    return left > 0 && left <= DECISION_WINDOW_MIN;
}

const TRADING_MODES = new Set<TradingMode>(['dry_run', 'semi_auto', 'auto']);

type Position = Awaited<ReturnType<typeof getOpenPositions>>[number];

/** 판단 감사 블록(§7). 어떤 수치로 그렇게 판단했는지가 행 하나로 재현돼야 한다. */
function mrDetail(
    reading: SymbolReading | null,
    regime: RegimeReading | null,
    extra: Record<string, unknown> = {},
) {
    return {
        mr: {
            price: reading?.price ?? null,
            rsi2: reading?.rsi2 ?? null,
            sma200: reading?.sma200 ?? null,
            sma5: reading?.sma5 ?? null,
            atr14: reading?.atrPrev ?? null,
            spyPrice: regime?.price ?? null,
            spySma200: regime?.sma200 ?? null,
            ...extra,
        },
    };
}

async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const cronRunId = `exec-${crypto.randomUUID()}`;
    const runDeadlineMs = startedMs + RUN_DEADLINE_MS;
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });
    const todayEt = etDateOf(startedAt);

    // 실행 간격 게이트. 감사 행보다 **앞** — 건너뛴 틱까지 cron_runs에 남기면 잡음이 된다.
    // 설정 조회 실패는 기본값으로 진행한다. `?force=1`은 수동 트리거용 우회.
    const executeInterval = await getConfigValue<unknown>(db, 'execute_interval_min')
        .then(parseExecuteInterval)
        .catch(() => DEFAULT_EXECUTE_INTERVAL_MIN);
    const forceRun = new URL(req.url).searchParams.get('force') === '1';
    if (!forceRun && !isExecuteTick(startedAt, executeInterval)) {
        return Response.json({ skipped: true, reason: 'off_interval', executeInterval });
    }

    // 판단 틱인가 — 창 안이고 오늘 판단을 아직 끝내지 않았다. 조회 실패는 "아직 안 함"으로 본다:
    // 판단을 두 번 해도 열린 포지션·in-flight 매수 가드가 중복 주문을 막지만(§4.2), 판단을
    // 건너뛰면 그날이 통째로 사라진다.
    const decisionWindow = isInDecisionWindow(startedAt);
    const decisionTick =
        decisionWindow &&
        !(await hasDecisionPhaseSince(db, etDayStart(startedAt)).catch(() => false));

    // 판단 틱이 아니고 보유도 없으면 할 일이 없다 — 감사 행 없이 돌아간다(§4.1, 하루 50여 행의 잡음).
    // 조회가 실패하면 판단할 수 없으므로 정상 경로로 들어가 오류를 기록하게 한다.
    if (!decisionTick && !forceRun) {
        const held = await getOpenPositions(db).catch(() => null);
        if (held !== null && held.length === 0) {
            return Response.json({ skipped: true, reason: 'idle' });
        }
    }

    await safe(finalizeStaleCronRuns(db, startedAt));
    await safe(startCronRun(db, { runId: cronRunId, cronType: 'execute', startedAt }));

    let finishState: CronRunFinish | null = null;
    const decisions: ExecuteDecision[] = [];

    try {
        if (!isEtRegularSessionOpen(new Date())) {
            finishState = { status: 'skipped', outcome: 'market_closed', ...elapsed() };
            return Response.json({ skipped: true, reason: 'market_closed' });
        }

        // 락 TTL은 한 실행의 최대 시간보다 커야 한다 — 만료되면 다음 틱이 락을 잡아 두 실행이 각자의
        // 노출·현금 스냅샷으로 같은 종목에 주문을 낸다. 실행 자체도 `RUN_DEADLINE_MS`에서 멈춘다.
        const lock = await acquireLockDetailed(LOCK_KEY, LOCK_TTL_SEC);
        const lockToken = lock.token;
        if (!lockToken) {
            // Redis 장애는 경합이 아니다 — `skipped`로 남기면 침묵 감시가 경보를 내지 않는다.
            finishState =
                lock.reason === 'unavailable'
                    ? {
                          status: 'error',
                          outcome: 'locked',
                          error: 'lock backend unavailable',
                          ...elapsed(),
                      }
                    : { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
        }

        try {
            const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
            const dispatcher = createEmailDispatcher({
                gate: makeEmailGate(emailNotif),
                to: emailNotif?.target,
                enqueue: (row) => enqueueNotification(db, row),
            });
            const notifyError = (subject: string, body: string) =>
                dispatcher.notifyError(subject, body).catch((e) => console.error('[email]', e));
            /** 같은 날 같은 경보는 한 번만. */
            const notifyOncePerDay = async (key: string, subject: string, body: string) => {
                if (await claimOnce(`mail:${key}:${todayEt}`, DAILY_MAIL_TTL_SEC)) {
                    await notifyError(subject, body);
                }
            };

            // 킬 스위치 — 운영자의 "아무것도 건드리지 마라". 청산까지 멈추는 유일한 차단기다.
            const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
            if (!tradingEnabled) {
                finishState = { status: 'skipped', outcome: 'trading_disabled', ...elapsed() };
                return Response.json({ skipped: true, reason: 'trading_disabled' });
            }

            await expireOldPendingOrders(db);

            const rawMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
            // 모르는 모드는 dry_run으로 — 손상된 행 때문에 실주문이 나가는 쪽보다 안전하다.
            const tradingMode: TradingMode = TRADING_MODES.has(rawMode as TradingMode)
                ? (rawMode as TradingMode)
                : 'dry_run';
            const exitPolicyNote =
                tradingMode === 'auto'
                    ? '보유 포지션의 청산 신호는 계속 처리되어 전량 시장가로 청산됩니다 (킬 스위치를 켜면 청산도 즉시 중단됩니다).'
                    : tradingMode === 'semi_auto'
                      ? '보유 포지션의 청산은 자동 실행되지 않고 승인 대기열에만 등록됩니다 — 대시보드에서 승인해야 체결됩니다.'
                      : '※ dry_run 시뮬레이션 — 위 손익은 모의 포지션 기준이며, 청산도 시뮬레이션으로만 기록됩니다 (실제 주문 없음). 실계좌 사고가 아닙니다.';

            const params = await readMrParams(db);
            const dryRunCostBps = await readDryRunCostBps(db);

            // in-flight 주문을 열린 포지션보다 먼저 읽는다(A7) — 둘 사이에 reconcile 지연 체결
            // 복구가 끼어들면(주문을 지우고 포지션을 만듦) 순서가 반대였을 때 그 심볼이 이번
            // 런의 두 스냅샷 어디에도 없어 물타기 가드가 통째로 비어 버린다.
            const pendingSubmittedOrders = await getPendingSubmittedOrders(db);
            const openPositions = await getOpenPositions(db);
            const watchlistItems = decisionTick ? await getEnabledWatchlist(db) : [];

            // --- 시세 프리페치. 판단 틱이면 관심종목과 국면 지수까지 ---
            const quotes = new Map<
                string,
                { price: number | null; previousClose: number | null }
            >();
            const priceFailures = new Map<string, LivePriceDetail>();
            const symbols = new Set<string>();
            for (const p of openPositions) symbols.add(p.symbol);
            for (const o of pendingSubmittedOrders) symbols.add(o.symbol);
            if (decisionTick) {
                for (const w of watchlistItems) symbols.add(w.symbol);
                symbols.add(REGIME_SYMBOL);
            }
            // 마감으로 실행이 잘린 흔적. 시세 프리페치가 여기서 끊기면 판단 단계가 국면·후보
            // 시세 없이 도는 것과 같으므로, 판단 단계의 다른 마감 감지와 같은 플래그로 합친다(A3).
            let deadlineHit = false;
            let closeCutoffHit = false;
            for (const sym of symbols) {
                if (Date.now() > runDeadlineMs) {
                    deadlineHit = true;
                    console.warn('[execute] 시세 프리페치가 실행 마감으로 잘렸다');
                    break;
                }
                const detail = await fetchLivePriceDetail(sym).catch(
                    (err): LivePriceDetail => ({
                        source: 'fmp_quote',
                        price: null,
                        reason: 'request_failed',
                        error: err instanceof Error ? err.message : String(err),
                    }),
                );
                quotes.set(sym, {
                    price: detail.price && detail.price > 0 ? detail.price : null,
                    previousClose: detail.previousClose ?? null,
                });
                if (!(detail.price && detail.price > 0)) priceFailures.set(sym, detail);
            }
            const priceOf = (sym: string) => quotes.get(sym)?.price ?? 0;

            // --- 차단기. 새 리스크만 막고 리스크 축소(청산)는 막지 않는다(원칙 7) ---
            let entryBlock: { outcome: 'daily_trade_limit' | 'daily_loss_limit' } | null = null;
            let forceFullExit = false;

            const maxTradesPerDay = (await getConfigValue<number>(db, 'max_trades_per_day')) ?? 20;
            const [todayTradeCount, todayInflightCount] = await Promise.all([
                getTodayTradeCount(db),
                getTodayInflightOrderCount(db),
            ]);
            if (todayTradeCount + todayInflightCount >= maxTradesPerDay) {
                entryBlock = { outcome: 'daily_trade_limit' };
            }

            const maxDailyLoss = (await getConfigValue<number>(db, 'max_daily_loss_usd')) ?? 500;
            const todayPnl = await getTodayRealizedPnl(db, tradingMode);
            let unrealizedToday = 0;
            if (todayPnl < -maxDailyLoss) {
                await notifyOncePerDay(
                    'daily-loss',
                    '일일 손실 한도 초과',
                    `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)})이 한도($${maxDailyLoss})를 초과하여 신규 진입이 중지되었습니다.\n${exitPolicyNote}`,
                );
                entryBlock = { outcome: 'daily_loss_limit' };
                forceFullExit = true;
            } else if (openPositions.length > 0) {
                // 미실현 항은 **오늘 변동분**이다(§4.5) — 누적이면 눌린 포지션 하나가 며칠씩 진입을 막는다.
                const change = todayUnrealizedChange(
                    openPositions.map((p) => ({
                        symbol: p.symbol,
                        quantity: p.quantity,
                        avgPrice: safeNumber(Number(p.avgPrice), 0),
                        openedDate: etDateOf(p.openedAt),
                    })),
                    quotes,
                    todayEt,
                );
                unrealizedToday = change.total;
                if (change.divergent.length > 0) {
                    await notifyOncePerDay(
                        'quote-divergence',
                        `시세 이상 (${change.divergent.length}건, ${tradingMode})`,
                        `실시간 호가가 기준가(전일 종가 또는 오늘 진입가)에서 25% 넘게 벗어나 일일 손실 계산에서 변동 0으로 두었습니다. 시세 피드 확인이 필요합니다.\n\n${change.divergent.join(', ')}`,
                    );
                }
                const total = todayPnl + unrealizedToday;
                if (total < -maxDailyLoss) {
                    await notifyOncePerDay(
                        'daily-loss',
                        '일일 손실 한도 초과 (미실현 포함)',
                        `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)}) + 오늘 미실현 변동($${Math.abs(unrealizedToday).toFixed(2)}) = 총 $${Math.abs(total).toFixed(2)}이 한도($${maxDailyLoss})를 초과하여 신규 진입이 중지되었습니다.\n${exitPolicyNote}`,
                    );
                    entryBlock = { outcome: 'daily_loss_limit' };
                    forceFullExit = true;
                }
            }

            // 보유도 없고 판단 틱도 아니면 차단기는 그냥 건너뜀이다.
            if (entryBlock && openPositions.length === 0 && !decisionTick) {
                finishState = { status: 'skipped', outcome: entryBlock.outcome, ...elapsed() };
                return Response.json({ skipped: true, reason: `${entryBlock.outcome}_reached` });
            }

            // 예정 외 휴장(국가 애도의 날 등)은 규칙으로 알 수 없으니 실주문 경로만 브로커에게 직접 묻는다.
            if (tradingMode !== 'dry_run') {
                let marketOpen: boolean;
                try {
                    marketOpen = await isUsMarketOpen();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await notifyError(
                        '미국장 상태 조회 실패',
                        `브로커 시장 캘린더 조회에 실패하여 ${tradingMode} 주문 실행을 건너뜁니다.\n오류: ${message}`,
                    );
                    finishState = {
                        status: 'skipped',
                        outcome: 'market_status_unavailable',
                        ...elapsed(),
                    };
                    return Response.json({
                        skipped: true,
                        reason: 'market_status_unavailable',
                        error: message,
                    });
                }
                if (!marketOpen) {
                    finishState = { status: 'skipped', outcome: 'us_market_holiday', ...elapsed() };
                    return Response.json({ skipped: true, reason: 'us-market-holiday' });
                }
            }

            const maxPositionSize = (await getConfigValue<number>(db, 'max_position_size')) ?? 1000;
            const maxTotalExposure =
                (await getConfigValue<number>(db, 'max_total_exposure')) ?? 5000;
            // 장부와 브로커가 어긋난 채 사람 손을 기다리는 심볼 — 신규 진입만 막는다. 조회 실패는 삼킨다.
            const needsReviewSymbols = new Set(
                await getNeedsReviewSymbols(db, new Date(startedMs - 86_400_000)).catch((err) => {
                    console.error('[execute] needs_review 조회 실패 — 진입 가드 미적용', err);
                    return [] as string[];
                }),
            );

            // 노출 한도의 단위는 **투입 원가**다 — 평가액이면 가격이 내릴수록 예산이 커진다.
            const costBasisOf = (p: { avgPrice: unknown; quantity: number }) =>
                safeNumber(Number(p.avgPrice), 0) * p.quantity;
            let currentExposure = openPositions.reduce((sum, p) => sum + costBasisOf(p), 0);
            // in-flight 매수(`error` 포함 — 브로커가 갖고 있을 수 있다)와 semi_auto 승인 대기 매수도 노출이다.
            let pendingBuyExposure = 0;
            const pendingBuyExposureMissingPrice: string[] = [];
            for (const order of pendingSubmittedOrders) {
                if (order.side !== 'buy') continue;
                const px = priceOf(order.symbol);
                if (px > 0) pendingBuyExposure += px * order.quantity;
                else pendingBuyExposureMissingPrice.push(order.symbol);
            }
            const approvals = await getPendingOrders(db);
            for (const pending of approvals) {
                if (pending.side !== 'buy' || pending.status !== 'pending') continue;
                const limit = safeNumber(Number(pending.priceLimit), 0);
                const px = limit > 0 ? limit : priceOf(pending.symbol);
                if (px > 0) pendingBuyExposure += px * pending.quantity;
                else pendingBuyExposureMissingPrice.push(pending.symbol);
            }
            currentExposure += pendingBuyExposure;

            // 세 모드 모두 "지금 쓸 수 있는 돈"(auto·semi_auto = 브로커 잔고, dry_run = 예치금 + 원장).
            let remainingBuyingPower: number | null = await getAvailableCashUsd(db, tradingMode);

            const orderCtx = { db, tradingMode, cronRunId, dispatcher, notifyError, dryRunCostBps };
            const killSwitchOff = async () =>
                !((await getConfigValue<boolean>(db, 'trading_enabled')) ?? true);
            /** 청산 공통 경로 — 결과를 결정 행으로 남긴다. */
            const exitPosition = async (
                position: Position,
                action: string,
                reason: string,
                isStopLoss: boolean,
                detail: Record<string, unknown>,
            ): Promise<OrderOutcome> => {
                const outcome = await executeExit(orderCtx, {
                    position,
                    quantity: position.quantity,
                    price: priceOf(position.symbol),
                    reason,
                    isStopLoss,
                });
                currentExposure = Math.max(0, currentExposure + outcome.exposureDelta);
                decisions.push({
                    symbol: position.symbol,
                    action: outcome.action ?? action,
                    score: 0,
                    executed: outcome.executed,
                    reason,
                    detail: { ...detail, ...(outcome.order ? { order: outcome.order } : {}) },
                });
                return outcome;
            };

            // 이 실행에서 청산(또는 청산 주문)한 종목 — 같은 틱에 다시 사지 않는다(백테스트도 청산 다음 날부터).
            const exitedSymbols = new Set<string>();
            let stopBackfilled = 0;

            // =====================================================================
            // 위험 단계 — 매 틱
            // =====================================================================
            for (const position of openPositions) {
                if (Date.now() > runDeadlineMs) {
                    deadlineHit = true;
                    decisions.push({ symbol: position.symbol, action: 'run_deadline', score: 0 });
                    continue;
                }
                try {
                    // 이미 나간 매도 주문(또는 semi_auto 승인 대기)이 있으면 또 내지 않는다.
                    const hasPendingSell = pendingSubmittedOrders.some(
                        (o) =>
                            o.symbol === position.symbol &&
                            o.side === 'sell' &&
                            ['submitted', 'pending', 'partial'].includes(o.status),
                    );
                    const hasPendingApprovalSell =
                        tradingMode === 'semi_auto' &&
                        (await getPendingOrders(db)).some(
                            (o) =>
                                o.symbol === position.symbol &&
                                o.side === 'sell' &&
                                o.status === 'pending',
                        );
                    if (hasPendingSell || hasPendingApprovalSell) {
                        exitedSymbols.add(position.symbol);
                        decisions.push({
                            symbol: position.symbol,
                            action: 'pending_sell_in_progress',
                            score: 0,
                        });
                        continue;
                    }

                    // 재난 손절가가 비어 있으면 채운다 — 승인·복구 경로로 열린 포지션이다(§4.2).
                    // `params.stopAtr > 0` 가드가 없으면 손절 없는 포지션(`mr_stop_atr = 0`)까지
                    // 매 틱 일봉을 받아 온다 — 어차피 `stopPriceFor`가 배수 0이면 null을 주므로 헛수고다.
                    let stopPrice =
                        position.stopPrice == null
                            ? null
                            : safeNumber(Number(position.stopPrice), 0) || null;
                    if (stopPrice === null && params.stopAtr > 0) {
                        const bars = await fetchDailyBars(position.symbol, null, startedAt);
                        const openedDate = etDateOf(position.openedAt);
                        const atr = bars
                            ? wilderAtr(
                                  bars.filter((b) => b.date < openedDate),
                                  ATR_PERIOD,
                              )
                            : null;
                        const computed = stopPriceFor(
                            safeNumber(Number(position.avgPrice), 0),
                            atr,
                            params.stopAtr,
                        );
                        if (computed !== null) {
                            await setPositionStopPrice(db, position.id, computed).catch((err) =>
                                console.error('[execute] 손절가 채우기 실패', position.symbol, err),
                            );
                            stopPrice = computed;
                            stopBackfilled++;
                        } else {
                            // 일봉 실패든 ATR 계산 불가든 손절이 계속 비어 있다 — 조용히 두면
                            // 재난 손절이 다음 계산 성공 전까지 꺼진 채로 남는다(A6).
                            decisions.push({
                                symbol: position.symbol,
                                action: 'stop_backfill_failed',
                                score: 0,
                                detail: { reason: bars ? 'atr_unavailable' : 'bars_unavailable' },
                            });
                            await notifyOncePerDay(
                                `stop-backfill-${position.symbol}`,
                                `재난 손절가 계산 실패: ${position.symbol}`,
                                `${position.symbol} 포지션의 재난 손절가를 채우지 못했습니다(일봉 또는 ATR 계산 불가). 손절이 비어 있는 상태이니 수동 확인이 필요합니다.`,
                            );
                        }
                    }

                    const price = priceOf(position.symbol);
                    if (price <= 0) {
                        // auto는 시장가라 가격 없이도 청산할 수 있다 — 한도 초과 중이면 평가할 수 없는
                        // 포지션은 나간다. dry_run(현재가로 기록)·semi_auto(지정가 대기)는 가격 없이는 못 한다.
                        if (forceFullExit && tradingMode === 'auto') {
                            if (await killSwitchOff()) {
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'trading_disabled_mid_loop',
                                    score: 0,
                                });
                                continue;
                            }
                            exitedSymbols.add(position.symbol);
                            await exitPosition(
                                position,
                                'mr_forced_exit',
                                '일일 손실 한도 초과 — 가격 없이 시장가 전량 청산',
                                true,
                                {},
                            );
                            continue;
                        }
                        decisions.push({
                            symbol: position.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: { priceSource: priceFailures.get(position.symbol) ?? null },
                        });
                        await notifyOncePerDay(
                            `no-price-${position.symbol}`,
                            `가격 데이터 없음: ${position.symbol}`,
                            `${position.symbol} 포지션의 현재 가격을 확인할 수 없어 손절 판정을 건너뛰었습니다. 수동 확인이 필요합니다.`,
                        );
                        continue;
                    }

                    // 재난 손절가는 **진입 시점에 고정**된다(A4) — `mr_stop_atr`는 신규 진입과
                    // 위의 백필(비어 있는 손절)에만 적용된다. 이미 손절가가 있는 포지션은 그 값을
                    // 그대로 매 틱 비교할 뿐이라, 운영 중 `mr_stop_atr`를 0으로 바꿔도 이미 걸린
                    // 손절은 사라지지 않는다 — 없애려면 포지션을 직접 청산해야 한다.
                    if (isStopHit(price, stopPrice)) {
                        if (await killSwitchOff()) {
                            decisions.push({
                                symbol: position.symbol,
                                action: 'trading_disabled_mid_loop',
                                score: 0,
                            });
                            continue;
                        }
                        exitedSymbols.add(position.symbol);
                        await exitPosition(
                            position,
                            'mr_stop_atr',
                            `재난 손절 (손절 $${stopPrice!.toFixed(2)}, 현재 $${price.toFixed(2)})`,
                            true,
                            { mr: { price, stopPrice } },
                        );
                    }
                } catch (err) {
                    await notifyError(position.symbol, String(err));
                    decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
                }
            }

            // =====================================================================
            // 판단 단계 — 하루 1회
            // =====================================================================
            let decisionPhaseDone = false;
            if (decisionTick) {
                // A1: 이 시각 이후 매도된(또는 매도 진행 중인) 심볼 — 오늘 재매수 금지. 위험
                // 단계의 exitedSymbols는 "이번 런"만 보므로, 앞선 틱의 재난 손절이나 판단 도중
                // 죽은 런이 이미 낸 매도를 놓친다. 조회가 실패하면 그날 진입 전체를 막는다(fail-closed).
                let soldTodaySymbols: Set<string>;
                let soldTodayQueryFailed = false;
                try {
                    soldTodaySymbols = await getSymbolsSoldSince(db, etDayStart(startedAt));
                } catch (err) {
                    console.error(
                        '[execute] getSymbolsSoldSince 조회 실패 — 오늘 진입 전체 차단',
                        err,
                    );
                    soldTodaySymbols = new Set();
                    soldTodayQueryFailed = true;
                }
                // A5a — 마감 1분 이내로는 새 주문을 내지 않는다. 판단 시점이 아니라 **제출 시점**의
                // 현재 시각으로 매번 다시 잰다.
                const closeCutoffNow = () =>
                    minutesUntilUsMarketClose(new Date(), etMinutesOfDay(new Date())) <= 1;

                const stillHeld = openPositions.filter((p) => !exitedSymbols.has(p.symbol));
                const heldSymbols = new Set(stillHeld.map((p) => p.symbol));
                const barSymbols = new Set<string>([
                    REGIME_SYMBOL,
                    ...stillHeld.map((p) => p.symbol),
                    ...watchlistItems.map((w) => w.symbol),
                ]);
                const barsBySymbol = new Map<string, DailyBar[] | null>(
                    await Promise.all(
                        [...barSymbols].map(
                            async (sym) =>
                                [
                                    sym,
                                    await fetchDailyBars(
                                        sym,
                                        quotes.get(sym)?.price ?? null,
                                        startedAt,
                                    ),
                                ] as const,
                        ),
                    ),
                );
                const spyBars = barsBySymbol.get(REGIME_SYMBOL) ?? null;
                // A2: 실시간 SPY 가격이 없으면 `fetchDailyBars`가 전일 종가 계열을 그대로 돌려준다
                // (오늘 봉을 합성하지 못했으므로) — 국면 필터가 켜진 채로 그 계열을 읽으면 어제
                // 종가로 오늘 국면을 판단하게 된다. 필터가 켜져 있을 때는 국면 자체를 불가로
                // 본다(fail-closed) — 이미 있는 SPY `mr_data_error` 분기를 그대로 태운다.
                const regimeUnavailable = params.regimeFilter && priceOf(REGIME_SYMBOL) <= 0;
                const regime = spyBars && !regimeUnavailable ? readRegime(spyBars) : null;

                // --- 규칙 청산: 평가할 수 있으면 평가를 따르고, 못 하면(한도 초과 중) 나간다 ---
                for (const position of stillHeld) {
                    if (Date.now() > runDeadlineMs) {
                        deadlineHit = true;
                        decisions.push({
                            symbol: position.symbol,
                            action: 'run_deadline',
                            score: 0,
                        });
                        continue;
                    }
                    // A5a — 마감 1분 이내는 이 런에서 더 주문을 내지 않는다(규칙 청산·강제 청산 공용).
                    if (closeCutoffHit || closeCutoffNow()) {
                        closeCutoffHit = true;
                        decisions.push({
                            symbol: position.symbol,
                            action: 'close_cutoff',
                            score: 0,
                        });
                        continue;
                    }
                    try {
                        const price = priceOf(position.symbol);
                        if (price <= 0) {
                            // 실시간 가격이 없으면 일봉의 마지막 봉이 어제다 — 어제 종가로 오늘을 판단하지 않는다.
                            // (auto + 한도 초과는 위험 단계에서 이미 시장가로 나갔다.)
                            decisions.push({
                                symbol: position.symbol,
                                action: 'mr_data_error',
                                score: 0,
                                detail: { reason: 'no_live_price' },
                            });
                            continue;
                        }
                        const bars = barsBySymbol.get(position.symbol) ?? null;
                        const reading = bars ? readSymbol(bars) : null;
                        const openedDate = etDateOf(position.openedAt);
                        if (!bars || !reading) {
                            if (forceFullExit) {
                                if (await killSwitchOff()) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'trading_disabled_mid_loop',
                                        score: 0,
                                    });
                                } else {
                                    exitedSymbols.add(position.symbol);
                                    await exitPosition(
                                        position,
                                        'mr_forced_exit',
                                        '일일 손실 한도 초과 — 일봉 없이 강제 전량 청산',
                                        true,
                                        mrDetail(null, regime),
                                    );
                                }
                            } else {
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'mr_data_error',
                                    score: 0,
                                    detail: {
                                        reason: bars ? 'insufficient_history' : 'bars_unavailable',
                                    },
                                });
                            }
                            continue;
                        }
                        const held = holdDays(bars, openedDate);
                        const exit = evaluateRuleExit({
                            reading,
                            holdDays: held,
                            entryDate: openedDate,
                            maxHoldDays: params.maxHoldDays,
                        });
                        const detail = mrDetail(reading, regime, {
                            holdDays: held,
                            stopPrice:
                                position.stopPrice == null ? null : Number(position.stopPrice),
                        });
                        if (!exit) {
                            decisions.push({
                                symbol: position.symbol,
                                action: 'mr_hold',
                                score: reading.rsi2,
                                detail,
                            });
                            continue;
                        }
                        if (await killSwitchOff()) {
                            decisions.push({
                                symbol: position.symbol,
                                action: 'trading_disabled_mid_loop',
                                score: reading.rsi2,
                            });
                            continue;
                        }
                        exitedSymbols.add(position.symbol);
                        await exitPosition(
                            position,
                            `mr_exit_${exit.kind}`,
                            exit.reason,
                            false,
                            detail,
                        );
                    } catch (err) {
                        await notifyError(position.symbol, String(err));
                        decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
                    }
                }

                // --- 진입 ---
                const notHeldOrExited = watchlistItems.filter(
                    (w) => !heldSymbols.has(w.symbol) && !exitedSymbols.has(w.symbol),
                );
                // A1: 오늘 이미 팔렸거나 매도 진행 중인 심볼은 다시 사지 않는다(§3 "물타기 없음" —
                // 백테스트도 청산 다음 날부터 재진입했다). 조회가 실패하면 오늘 진입 전체를 막는다.
                let candidates = notHeldOrExited;
                if (soldTodayQueryFailed) {
                    // 후보가 없어도(전부 보유 중이라도) 조회 실패 자체를 기록해야 `hadDataError`가
                    // true가 되어 그날이 재시도된다 — 후보 수로 게이팅하면 조용히 성공 처리된다.
                    candidates = [];
                    decisions.push({
                        action: 'mr_data_error',
                        score: 0,
                        detail: { reason: 'sold_today_query_failed' },
                    });
                } else if (soldTodaySymbols.size > 0) {
                    candidates = [];
                    for (const w of notHeldOrExited) {
                        if (soldTodaySymbols.has(w.symbol)) {
                            decisions.push({
                                symbol: w.symbol,
                                action: 'mr_hold',
                                score: 0,
                                detail: mrDetail(null, regime, { reason: 'sold_today' }),
                            });
                        } else {
                            candidates.push(w);
                        }
                    }
                }
                if (candidates.length > 0 && params.regimeFilter && regime === null) {
                    // SPY를 못 읽으면 그날 진입은 없다(fail-closed, §3). 고장과 "신호 없음"을 구분한다.
                    decisions.push({
                        symbol: REGIME_SYMBOL,
                        action: 'mr_data_error',
                        score: 0,
                        detail: { regime: 'unavailable' },
                    });
                } else if (candidates.length > 0 && params.regimeFilter && regime && !regime.up) {
                    decisions.push({
                        action: 'mr_regime_off',
                        score: 0,
                        detail: mrDetail(null, regime, { candidates: candidates.length }),
                    });
                } else {
                    const signals: Array<{ symbol: string; reading: SymbolReading; rsi2: number }> =
                        [];
                    for (const item of candidates) {
                        if (priceOf(item.symbol) <= 0) {
                            // 실시간 가격 없이는 오늘 봉이 없다 — 어제 종가로 신호를 내지 않는다.
                            decisions.push({
                                symbol: item.symbol,
                                action: 'mr_data_error',
                                score: 0,
                                detail: { reason: 'no_live_price' },
                            });
                            continue;
                        }
                        const bars = barsBySymbol.get(item.symbol) ?? null;
                        if (!bars) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'mr_data_error',
                                score: 0,
                                detail: { reason: 'bars_unavailable' },
                            });
                            continue;
                        }
                        const reading = readSymbol(bars);
                        if (!reading) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'mr_hold',
                                score: 0,
                                detail: { mr: { insufficientHistory: true } },
                            });
                            continue;
                        }
                        if (isEntrySignal(reading, regime, params)) {
                            signals.push({ symbol: item.symbol, reading, rsi2: reading.rsi2 });
                        } else {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'mr_hold',
                                score: reading.rsi2,
                                detail: mrDetail(reading, regime),
                            });
                        }
                    }

                    const ranked = rankSignals(signals);
                    for (const [index, signal] of ranked.entries()) {
                        const { symbol, reading } = signal;
                        const rank = index + 1;
                        const stopPrice = stopPriceFor(
                            reading.price,
                            reading.atrPrev,
                            params.stopAtr,
                        );
                        // A10: 이 심볼에 진입 신호가 있었음을 남긴다 — `executeEntry`가 아래에서
                        // 최종 action을 주문 결과(`order_submitted`·`needs_review`·`already_open` …)로
                        // 덮어써도 리뷰 크론이 `detail.mr.signal`로 이 결정 행을 여전히 찾을 수 있다.
                        const detail = mrDetail(reading, regime, { rank, stopPrice, signal: true });
                        if (Date.now() > runDeadlineMs) {
                            deadlineHit = true;
                            decisions.push({
                                symbol,
                                action: 'run_deadline',
                                score: reading.rsi2,
                                detail,
                            });
                            continue;
                        }
                        // A5a — 마감 1분 이내는 이 런에서 더 매수 주문을 내지 않는다.
                        if (closeCutoffHit || closeCutoffNow()) {
                            closeCutoffHit = true;
                            decisions.push({
                                symbol,
                                action: 'close_cutoff',
                                score: reading.rsi2,
                                detail,
                            });
                            continue;
                        }
                        try {
                            if (entryBlock) {
                                decisions.push({
                                    symbol,
                                    action: 'mr_skip_breaker',
                                    score: reading.rsi2,
                                    detail: { ...detail, blockedBy: entryBlock.outcome },
                                });
                                continue;
                            }
                            // in-flight 매수(`error` 포함)가 있으면 또 사지 않는다 — 판단이 재시도될 때
                            // auto는 체결 전이라 포지션이 아직 없다. 이 가드가 멱등의 한 축이다(§4.2).
                            const hasPendingBuy = pendingSubmittedOrders.some(
                                (o) => o.symbol === symbol && o.side === 'buy',
                            );
                            if (hasPendingBuy || needsReviewSymbols.has(symbol)) {
                                decisions.push({
                                    symbol,
                                    action: 'pending_order_in_progress',
                                    score: reading.rsi2,
                                    detail: {
                                        ...detail,
                                        needsReview: needsReviewSymbols.has(symbol),
                                    },
                                });
                                continue;
                            }
                            if (
                                tradingMode === 'semi_auto' &&
                                (await getPendingOrders(db)).some(
                                    (o) => o.symbol === symbol && o.status === 'pending',
                                )
                            ) {
                                decisions.push({
                                    symbol,
                                    action: 'pending_exists',
                                    score: reading.rsi2,
                                    detail,
                                });
                                continue;
                            }
                            const plan = planEntry({
                                price: reading.price,
                                fraction: 1,
                                maxPositionSize,
                                maxTotalExposure,
                                currentExposure,
                                existingSymbolExposure: 0,
                                availableCash: remainingBuyingPower,
                            });
                            if (plan.quantity === 0) {
                                decisions.push({
                                    symbol,
                                    action: 'mr_skip_budget',
                                    score: reading.rsi2,
                                    detail: {
                                        ...detail,
                                        budget: {
                                            fullBudget: plan.fullBudget,
                                            limitedBy: plan.limitedBy,
                                        },
                                    },
                                });
                                continue;
                            }
                            if (await killSwitchOff()) {
                                decisions.push({
                                    symbol,
                                    action: 'trading_disabled_mid_loop',
                                    score: reading.rsi2,
                                    detail,
                                });
                                continue;
                            }
                            const reason = `RSI(2) ${reading.rsi2.toFixed(1)} < ${params.rsiEntry} · 200일선 위 눌림 (현재 $${reading.price.toFixed(2)}, SMA200 $${reading.sma200.toFixed(2)})`;
                            const outcome = await executeEntry(orderCtx, {
                                symbol,
                                quantity: plan.quantity,
                                price: reading.price,
                                reason,
                                stopPrice,
                                score: reading.rsi2,
                                remainingBuyingPower,
                            });
                            currentExposure += outcome.exposureDelta;
                            if (remainingBuyingPower !== null) {
                                remainingBuyingPower = Math.max(
                                    0,
                                    remainingBuyingPower - outcome.cashDebit,
                                );
                            }
                            decisions.push({
                                symbol,
                                action: outcome.action ?? 'mr_buy',
                                score: reading.rsi2,
                                executed: outcome.executed,
                                reason,
                                detail: {
                                    ...detail,
                                    budget: {
                                        fullBudget: plan.fullBudget,
                                        limitedBy: plan.limitedBy,
                                        quantity: plan.quantity,
                                    },
                                    ...(outcome.order ? { order: outcome.order } : {}),
                                },
                            });
                        } catch (err) {
                            await notifyError(symbol, String(err));
                            decisions.push({
                                symbol,
                                action: 'error',
                                score: reading.rsi2,
                                detail,
                            });
                        }
                    }
                }
                // 판단이 진짜 끝났다고 볼 수 있을 때만 멱등 행을 남긴다(A3) — 아니면 재시도할 다음
                // 틱이 "오늘은 이미 끝났다"고 믿어 그날 판단이 통째로 사라진다. 넷 다 확인한다:
                // 실행 마감(시세 프리페치가 잘린 경우 포함, deadlineHit에 합쳐져 있다), 마감 1분
                // 컷오프, 국면 필요·불가(이미 `mr_data_error` 행으로 남는다), 그리고 이번 런에서
                // 어떤 형태로든 `mr_data_error`가 하나라도 났는가 — 데이터 실패가 있었다는 뜻이므로
                // 다음 틱이 다시 시도해야 한다.
                const hadDataError = decisions.some((d) => d.action === 'mr_data_error');
                decisionPhaseDone = !deadlineHit && !closeCutoffHit && !hadDataError;
            }

            if (deadlineHit) {
                await notifyError(
                    '실행 시간 초과 — 일부 종목 미처리',
                    `실행이 ${Math.round(RUN_DEADLINE_MS / 60_000)}분을 넘겨 남은 종목을 처리하지 않고 종료했습니다.\n` +
                        `다음 틱과 동시 실행되는 것을 막기 위한 정상 동작이지만, 반복되면 원인(대개 FMP 지연) 확인이 필요합니다.`,
                );
            }

            const decisionsByAction = decisions.reduce<Record<string, number>>((acc, d) => {
                acc[d.action] = (acc[d.action] ?? 0) + 1;
                return acc;
            }, {});
            finishState = {
                status: 'completed',
                outcome: entryBlock ? entryBlock.outcome : 'completed',
                summary: {
                    symbolsEvaluated: decisions.length,
                    decisionsByAction,
                    decisionTick,
                    ...(decisionPhaseDone ? { decisionPhase: 'done' } : {}),
                    pendingBuyExposure,
                    pendingBuyExposureMissingPrice,
                    todayRealizedPnl: todayPnl,
                    todayUnrealizedChange: unrealizedToday,
                    ...(stopBackfilled > 0 ? { stopBackfilled } : {}),
                    ...(deadlineHit ? { runDeadlineHit: true } : {}),
                    ...(closeCutoffHit ? { closeCutoffHit: true } : {}),
                    ...(entryBlock
                        ? {
                              exitOnly: true,
                              entriesBlockedBy: entryBlock.outcome,
                              exitsForcedFull: forceFullExit,
                          }
                        : {}),
                },
                ...elapsed(),
            };
            return Response.json({
                cronRunId,
                tradingMode,
                decisionTick,
                ...(entryBlock ? { entriesBlockedBy: entryBlock.outcome } : {}),
                decisions: decisions.map((d) => ({
                    symbol: d.symbol,
                    action: d.action,
                    ...(d.executed !== undefined ? { executed: d.executed } : {}),
                })),
            });
        } finally {
            await releaseLock(LOCK_KEY, lockToken).catch((e) => console.error('[lock-release]', e));
        }
    } catch (e) {
        finishState = {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            ...elapsed(),
        };
        throw e;
    } finally {
        if (finishState) {
            await safe(finishCronRun(db, cronRunId, finishState));
            await safe(
                insertCronDecisions(
                    db,
                    cronRunId,
                    'execute',
                    decisions.map((d) => ({
                        symbol: d.symbol,
                        action: d.action,
                        score: d.score,
                        executed: d.executed ?? false,
                        reason: d.reason,
                        detail: d.detail,
                    })),
                ),
            );
        }
    }
}

// Named HTTP-method export — `server/app.ts` mounts it and node-cron calls it in-process.
export const GET = handler;
