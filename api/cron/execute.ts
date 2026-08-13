import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    getEnabledWatchlist,
    getConfigValue,
    getLatestAnalysisResult,
    getOpenPositions,
    getOpenPositionBySymbol,
    openPosition,
    closePosition,
    reducePositionQuantity,
    insertTrade,
    insertPendingOrder,
    getPendingOrders,
    getTodayTradeCount,
    getTodayInflightOrderCount,
    getTodayRealizedPnl,
    expireOldPendingOrders,
    createOrderTracking,
    updateOrderTracking,
    getPendingSubmittedOrders,
    averageIntoPosition,
    getNotificationConfig,
    enqueueNotification,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
    insertCronDecisions,
    getAnalysisConfig,
} from '../../lib/db/queries.js';
import type { CronDecisionInput, CronRunFinish } from '../../lib/db/queries.js';
import { getAnalysisReferenceTime } from '../../lib/analysis/source-time.js';
import { computeConfluence } from '../../lib/analysis/confluence.js';
import { isConfluenceExit } from '../../lib/strategy/confluence.js';
import type { ConfluenceSnapshot } from '../../lib/strategy/confluence.js';
import { getTechnicalMaxAgeMs, normalizeAnalysisTimeframe } from '../../lib/analysis/timeframe.js';
import { scoreSignals } from '../../lib/strategy/signal-scorer.js';
import { evaluateExistingPosition } from '../../lib/strategy/risk-manager.js';
import { planEntry, planExit } from '../../lib/strategy/trade-plan.js';
import type { EntryPlan, ExitTrigger } from '../../lib/strategy/trade-plan.js';
import { runTradeGate } from '../../lib/analysis/trade-gate.js';
import type {
    TradeGateAnalysisEntry,
    TradeGateKind,
    TradeGateOutcome,
} from '../../lib/analysis/trade-gate.js';
import { resolveApiKey } from './_run-analysis-cron.js';
import { makeTradeDecision } from '../../lib/strategy/decision.js';
import { executeBuyOrder, executeSellOrder } from '../../lib/trading/orders.js';
import { getBuyingPower, getSellableQuantity, isUsMarketOpen } from '../../lib/trading/account.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import { createEmailDispatcher } from '../../lib/notification/dispatch.js';
import {
    weightsForTimeframe,
    DEFAULT_BUY_THRESHOLD,
    DEFAULT_SELL_THRESHOLD,
} from '../../lib/strategy/types.js';
import type { ScoreWeights, SignalScore } from '../../lib/strategy/types.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';
import { fetchLivePrice, fetchLivePriceDetail } from '../../lib/data/live-price.js';
import type { LivePriceDetail } from '../../lib/data/live-price.js';
import { safeNumber } from '../../lib/validation.js';
import {
    safeRecord,
    safeString,
    safeAnalysisPrice,
    safeAnalysisTrend,
    safeAnalysisSentiment,
    safeAnalysisSupport,
    safeAnalysisResistance,
    safeAnalysisTargetPrice,
    safeArray,
    safeActionRecommendation,
    safeAnalysisIndicators,
    safeFundamentalCategories,
} from '../../lib/strategy/safe-extract.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

type ExecuteDecision = CronDecisionInput & { symbol?: string; score: number };

function noPriceDetail(
    symbol: string,
    livePriceDetail: LivePriceDetail | undefined,
    technicalResult: unknown,
) {
    return {
        symbol,
        priceSources: {
            live: livePriceDetail ?? {
                source: 'fmp_quote',
                price: null,
                reason: 'not_available',
                error: 'FMP quote did not return a usable positive price',
            },
            analysisFallback: {
                source: 'technical.keyLevels.currentPrice',
                price: safeAnalysisPrice(technicalResult),
                usable: safeAnalysisPrice(technicalResult) > 0,
            },
        },
    };
}

/**
 * Audit detail recorded for every decision produced from a real signal score
 * (hold/buy/sell/average_in). Captures the component breakdown, the raw signal,
 * the active thresholds, and the source-analysis timestamp so a held or executed
 * decision can be explained after the fact.
 */
function scoreDecisionDetail(
    signalScore: SignalScore,
    buyThreshold: number,
    sellThreshold: number,
    sourceAnalyzedAt: Date | null,
    confluence: ConfluenceSnapshot | null = null,
) {
    // Guard against an Invalid Date (e.g. analysis row without a parseable
    // timestamp) — toISOString() would throw on a NaN-time Date.
    const sourceIso =
        sourceAnalyzedAt && Number.isFinite(sourceAnalyzedAt.getTime())
            ? sourceAnalyzedAt.toISOString()
            : null;
    return {
        components: signalScore.components,
        // 컨플루언스 보정이 걸리면 `signal='sell'`인데 `total`이 매도 임계값을 크게 웃돈다.
        // 이 값이 없으면 그 행은 저장된 숫자만으로 재현되지 않아 버그와 구분되지 않는다.
        totalWithoutConfluence: signalScore.totalWithoutConfluence,
        signal: signalScore.signal,
        thresholds: { buy: buyThreshold, sell: sellThreshold },
        sourceAnalyzedAt: sourceIso,
        // 어떤 지표가 켜져 있었는지까지 남긴다. 점수만으로는 사후에 재현할 수 없다.
        confluence,
    };
}

/**
 * Where a sizing `fraction` came from. Recorded on every decision the gate took part in so
 * an audit can tell "the model chose half" from "the model was never asked".
 */
type GateSource = 'ai' | 'disabled' | 'hard' | 'error' | 'deadline' | 'risk_halt';

/**
 * How far the live quote may sit from the technical snapshot before the snapshot is used
 * instead for the daily-loss breaker.
 *
 * Two same-session sources normally differ by a fraction of a percent — the snapshot is at
 * most `getTechnicalMaxAgeMs` old (45min–2h). 25% still clears a violent but real gap without
 * crying wolf, while every classic feed corruption (decimal shift, cents/dollars mixup,
 * another listing's price) is an order of magnitude outside it. Deliberately compared against
 * the snapshot and not `avgPrice`: the entry price can be weeks old, so a position genuinely
 * down 70% would fail an entry-relative band on every run and be silently under-counted.
 */
const MAX_PRICE_SOURCE_DIVERGENCE = 0.25;

/** Analysis rows the gate prompt reads, in the order `trade-gate.ts` renders them. */
const GATE_AXES: Array<TradeGateAnalysisEntry['type']> = [
    // 컨플루언스가 선두인 이유 — 유일하게 LLM을 거치지 않은 결정론적 축이라
    // 다른 축과 충돌할 때 기준점이 된다. `trade-gate.ts`의 렌더 순서와 같다.
    'confluence',
    'technical',
    'news',
    'options',
    'fundamental',
    'congress',
];

type AnalysisRow = {
    result: unknown;
    modelId?: string | null;
    analyzedAt: Date | string;
    sourceAnalyzedAt?: Date | string | null;
} | null;

/**
 * Builds the gate's five-axis analysis block.
 *
 * A missing axis is passed through as `result: null` rather than dropped: `trade-gate.ts`
 * prints "데이터 없음" for it on purpose, and a silently absent section reads to the model as
 * "not applicable", which invites it to invent one.
 */
function toGateAnalyses(rows: Partial<Record<TradeGateAnalysisEntry['type'], AnalysisRow>>) {
    return GATE_AXES.map((type) => {
        const row = rows[type] ?? null;
        return {
            type,
            result: row?.result ?? null,
            // source_analyzed_at (the LLM's own stamp) wins over the row's write time —
            // same freshness clock the staleness guard above uses.
            analyzedAt: row ? getAnalysisReferenceTime(row) : null,
            modelId: row?.modelId ?? null,
        };
    });
}

/**
 * Audit block merged into `cron_decisions.detail` (design doc §9.3). Entry decisions carry the
 * budget that bounded them; exits have no buy budget, so those fields stay null.
 */
function gateDetail(params: {
    kind: TradeGateKind;
    source: GateSource;
    model: string;
    fraction: number;
    outcome: TradeGateOutcome | null;
    plan?: EntryPlan | null;
    quantity: number;
}) {
    const ok = params.outcome?.status === 'ok' ? params.outcome : null;
    return {
        gate: {
            kind: params.kind,
            source: params.source,
            model: params.model,
            fraction: params.fraction,
            confidence: ok?.confidence ?? null,
            reason:
                ok?.reason ??
                (params.outcome?.status === 'error' ? params.outcome.error : null) ??
                null,
            fullBudget: params.plan?.fullBudget ?? null,
            trancheBudget: params.plan?.trancheBudget ?? null,
            limitedBy: params.plan?.limitedBy ?? null,
            quantity: params.quantity,
        },
    };
}

function publicDecision(decision: ExecuteDecision) {
    return {
        symbol: decision.symbol,
        action: decision.action,
        score: decision.score,
        ...(decision.executed !== undefined ? { executed: decision.executed } : {}),
    };
}

async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Audit helpers — best-effort, never abort trading
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const cronRunId = `exec-${crypto.randomUUID()}`;
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    // Finalize any audit rows stuck in 'running' past the stale threshold (a
    // prior invocation that timed out before writing its finish row). Best-effort.
    await safe(finalizeStaleCronRuns(db, startedAt));
    await safe(startCronRun(db, { runId: cronRunId, cronType: 'execute', startedAt }));

    let finishState: CronRunFinish | null = null;
    const decisions: ExecuteDecision[] = [];

    try {
        // Skip trade execution outside the U.S. regular session (cron schedule is a static approximation)
        if (!isEtRegularSessionOpen(new Date())) {
            finishState = { status: 'skipped', outcome: 'market_closed', ...elapsed() };
            return Response.json({ skipped: true, reason: 'market_closed' });
        }

        const LOCK_KEY = 'cron:execute:lock';
        // TTL < maxDuration(800s): a hung run holds the lock for its whole life (no mid-run expiry/overlap), and a killed fn's lock can't outlive it.
        const lockToken = await acquireLock(LOCK_KEY, 780);
        if (!lockToken) {
            finishState = { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'another_execution_in_progress' });
        }

        try {
            // Email notification gate + dispatcher — respect the dashboard ON/OFF toggle,
            // per-event selection, configured recipient (A2), and quiet-hours deferral.
            // Legacy 'approval_required' is honored as an alias for 'order_pending'.
            // Defined early so circuit-breaker alerts below also go through the dispatcher.
            const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
            const shouldEmail = makeEmailGate(emailNotif);
            const dispatcher = createEmailDispatcher({
                gate: shouldEmail,
                to: emailNotif?.target,
                enqueue: (row) => enqueueNotification(db, row),
            });
            // Error/safety alerts are gated on the 'error' (시스템 오류) event — same contract
            // as reconcile's notifyError, so "email OFF" suppresses every email uniformly.
            const notifyError = (subject: string, body: string) =>
                dispatcher.notifyError(subject, body).catch((e) => console.error('[email]', e));

            // Circuit breaker: kill switch
            const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
            if (!tradingEnabled) {
                finishState = { status: 'skipped', outcome: 'trading_disabled', ...elapsed() };
                return Response.json({ skipped: true, reason: 'trading_disabled' });
            }

            // Clean up expired pending orders
            await expireOldPendingOrders(db);

            // Read ahead of the breakers: their alerts state what will still happen to open
            // positions, and that differs per mode (auto sells, semi_auto only queues an
            // approval, dry_run only simulates).
            const tradingMode = (await getConfigValue<string>(db, 'trading_mode')) ?? 'dry_run';
            const exitPolicyNote =
                tradingMode === 'auto'
                    ? '보유 포지션의 청산 신호는 계속 처리되어 전량 시장가로 청산됩니다 (킬 스위치를 켜면 청산도 즉시 중단됩니다).'
                    : tradingMode === 'semi_auto'
                      ? '보유 포지션의 청산은 자동 실행되지 않고 승인 대기열에만 등록됩니다 — 대시보드에서 승인해야 체결됩니다.'
                      : '※ dry_run 시뮬레이션 — 위 손익은 모의 포지션 기준이며, 청산도 시뮬레이션으로만 기록됩니다 (실제 주문 없음). 실계좌 사고가 아닙니다.';

            // Risk breakers below stop NEW RISK, not risk reduction. A breaker that also
            // blocks liquidation is a bug: with split exits the gate can defer a sell
            // indefinitely, so an early `return` here would mean the position is never
            // stopped out at all — the breaker would cap nothing while the loss grew.
            // So they set `entryBlock` (skip the watchlist loop) instead of returning, and
            // the loss breakers additionally set `forceFullExit` (every exit is treated as
            // `hard` → full size, gate bypassed). The kill switch is the sole exception and
            // still stops everything: it is the operator's explicit "stop trading".
            let entryBlock: {
                outcome: 'daily_trade_limit' | 'daily_loss_limit';
                body: unknown;
            } | null = null;
            let forceFullExit = false;

            // Circuit breaker: daily trade limit
            // Count both settled trades AND in-flight orders (submitted/pending/partial) so
            // concurrent/rapid runs cannot exceed the limit by racing before any order settles.
            const maxTradesPerDay = (await getConfigValue<number>(db, 'max_trades_per_day')) ?? 20;
            const [todayTradeCount, todayInflightCount] = await Promise.all([
                getTodayTradeCount(db),
                getTodayInflightOrderCount(db),
            ]);
            if (todayTradeCount + todayInflightCount >= maxTradesPerDay) {
                entryBlock = {
                    outcome: 'daily_trade_limit',
                    body: {
                        skipped: true,
                        reason: 'daily_trade_limit_reached',
                        todayCount: todayTradeCount + todayInflightCount,
                        limit: maxTradesPerDay,
                    },
                };
            }

            // Circuit breaker: daily loss limit
            const maxDailyLoss = (await getConfigValue<number>(db, 'max_daily_loss_usd')) ?? 500;
            const todayPnl = await getTodayRealizedPnl(db);
            if (todayPnl < -maxDailyLoss) {
                await notifyError(
                    '일일 손실 한도 초과',
                    `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)})이 한도($${maxDailyLoss})를 초과하여 신규 진입이 중지되었습니다.\n${exitPolicyNote}`,
                );
                entryBlock = {
                    outcome: 'daily_loss_limit',
                    body: {
                        skipped: true,
                        reason: 'daily_loss_limit_reached',
                        todayPnl,
                        limit: maxDailyLoss,
                    },
                };
                forceFullExit = true;
            }

            // Circuit breaker: unrealized loss limit
            // Fetch current prices for all open positions to calculate unrealized PnL.
            // Failures to fetch individual position prices are silently skipped (best-effort).
            // Skipped once the realized breaker already tripped — the state is identical
            // (entries blocked, exits forced full) and re-computing would only double-mail.
            const preCheckPositions = await getOpenPositions(db);
            if (!forceFullExit && preCheckPositions.length > 0) {
                let unrealizedPnl = 0;
                // Collected, not mailed per position: a real gap diverges every run until the
                // snapshot catches up, and one line per symbol per run is how an inbox stops
                // being read.
                const priceDivergences: string[] = [];
                for (const pos of preCheckPositions) {
                    try {
                        const livePreCheck = await fetchLivePrice(pos.symbol).catch(() => null);
                        const techForPos = await getLatestAnalysisResult(
                            db,
                            pos.symbol,
                            'technical',
                        );
                        // Cross-check the FMP quote against the technical snapshot.
                        // `fetchLivePrice` only checks "finite positive", so a corrupt quote
                        // would otherwise trip the loss limit — which now forces a full
                        // liquidation of every position.
                        //
                        // These are NOT independent sources. Both originate at FMP (quote
                        // endpoint vs OHLC via `getMarketDataProvider`), and the snapshot value
                        // is `keyLevels.currentPrice` — a number the LLM copied into its own
                        // JSON, not a raw feed reading. So this catches the dominant failure
                        // (one bad quote tick) and catches nothing vendor-wide: a symbol
                        // mapping error, an unadjusted split or a currency mixup corrupts both
                        // values together and passes the check.
                        // TODO: a genuinely independent cross-check needs the Yahoo provider
                        // already in `lib/data/` — out of scope here.
                        const snapshotPrice = safeAnalysisPrice(techForPos?.result);
                        const avgP = safeNumber(Number(pos.avgPrice), 0);
                        const liveOk = livePreCheck != null && livePreCheck > 0;
                        const diverged =
                            liveOk &&
                            snapshotPrice > 0 &&
                            Math.abs(livePreCheck - snapshotPrice) / snapshotPrice >
                                MAX_PRICE_SOURCE_DIVERGENCE;

                        // Substitute, never exclude. Dropping a position from the sum always
                        // understates the loss, which delays the very breaker this guard
                        // protects — and the entry price is the wrong yardstick anyway: it can
                        // be weeks old, so a position legitimately down 70% looked like a bad
                        // tick and was dropped on every single run.
                        //
                        // NOTE: this is the *breaker's* price only. The per-position exit
                        // decision below uses `priceCache` (the live quote) — so one run can
                        // legitimately value the same position at two different prices. On a
                        // real gap the aggregate breaker reads the snapshot and is blunt for up
                        // to one analysis cycle, while the stop-loss path sees the live drop
                        // and fires normally. Deliberate: the blunt side fails toward doing
                        // nothing destructive.
                        let curPrice: number;
                        if (diverged) {
                            curPrice = snapshotPrice;
                        } else if (liveOk) {
                            curPrice = livePreCheck;
                        } else if (snapshotPrice > 0) {
                            curPrice = snapshotPrice;
                        } else {
                            // Neither source has a price. avgPrice yields unrealized 0, which
                            // is the neutral "unknown" value, not a claim of "no loss" — the
                            // same contribution the previous no-price behavior produced, but
                            // reached explicitly.
                            curPrice = avgP;
                        }

                        if (diverged) {
                            priceDivergences.push(
                                `${pos.symbol}: 실시간 호가 $${livePreCheck} vs 기술분석 스냅샷 $${snapshotPrice} → 스냅샷 가격으로 합산`,
                            );
                        }
                        if (curPrice > 0) {
                            const dir = pos.side === 'short' ? avgP - curPrice : curPrice - avgP;
                            unrealizedPnl += dir * pos.quantity;
                        }
                    } catch {
                        // Skip this position's unrealized PnL — analysis data unavailable
                    }
                }
                if (priceDivergences.length > 0) {
                    await notifyError(
                        `시세 출처 불일치 (${priceDivergences.length}건, ${tradingMode})`,
                        `실시간 호가가 기술분석 스냅샷과 ${Math.round(MAX_PRICE_SOURCE_DIVERGENCE * 100)}% 넘게 어긋나 일일 손실 한도 계산에 스냅샷 가격을 사용했습니다. 시세 피드 확인이 필요합니다.\n\n${priceDivergences.join('\n')}`,
                    );
                }
                const totalPnl = todayPnl + unrealizedPnl;
                if (totalPnl < -maxDailyLoss) {
                    await notifyError(
                        '일일 손실 한도 초과 (미실현 포함)',
                        `오늘 실현 손실($${Math.abs(todayPnl).toFixed(2)}) + 미실현 손실($${Math.abs(unrealizedPnl).toFixed(2)}) = 총 $${Math.abs(totalPnl).toFixed(2)}이 한도($${maxDailyLoss})를 초과하여 신규 진입이 중지되었습니다.\n${exitPolicyNote}`,
                    );
                    entryBlock = {
                        outcome: 'daily_loss_limit',
                        body: {
                            skipped: true,
                            reason: 'daily_loss_limit_reached',
                            todayPnl,
                            unrealizedPnl,
                            totalPnl,
                            limit: maxDailyLoss,
                        },
                    };
                    forceFullExit = true;
                }
            }

            // Nothing held → nothing to liquidate, so a tripped breaker is just a skip
            // (identical response to the pre-split behavior).
            if (entryBlock && preCheckPositions.length === 0) {
                finishState = { status: 'skipped', outcome: entryBlock.outcome, ...elapsed() };
                return Response.json(entryBlock.body);
            }

            // Load config
            const maxPositionSize = (await getConfigValue<number>(db, 'max_position_size')) ?? 1000;
            const maxTotalExposure =
                (await getConfigValue<number>(db, 'max_total_exposure')) ?? 5000;
            const buyThreshold =
                (await getConfigValue<number>(db, 'buy_threshold')) ?? DEFAULT_BUY_THRESHOLD;
            const sellThreshold =
                (await getConfigValue<number>(db, 'sell_threshold')) ?? DEFAULT_SELL_THRESHOLD;

            const stopLossPercent = (await getConfigValue<number>(db, 'stop_loss_percent')) ?? 5;
            const takeProfitPercent =
                (await getConfigValue<number>(db, 'take_profit_percent')) ?? 10;
            const fixedExitEnabled =
                (await getConfigValue<boolean>(db, 'fixed_exit_enabled')) ?? false;
            const analysisTimeframe = normalizeAnalysisTimeframe(
                await getConfigValue<unknown>(db, 'analysis_timeframe'),
            );
            const maxTechnicalAge = getTechnicalMaxAgeMs(analysisTimeframe);

            /**
             * 실행 스코프 컨플루언스 캐시.
             *
             * 포지션 재평가 루프와 워치리스트 루프가 같은 심볼을 각각 한 번씩 보므로,
             * 캐시가 없으면 FMP 봉 조회가 심볼당 두 번 나간다. 한 실행 안에서 두 루프가
             * 서로 다른 스냅샷을 보는 것도 곤란하다 — 같은 틱의 판단은 같은 데이터에서 나와야 한다.
             */
            const confluenceCache = new Map<string, ConfluenceSnapshot | null>();
            const getConfluence = async (symbol: string): Promise<ConfluenceSnapshot | null> => {
                const cached = confluenceCache.get(symbol);
                if (cached !== undefined) return cached;
                let snapshot: ConfluenceSnapshot | null = null;
                try {
                    snapshot = await computeConfluence(symbol, analysisTimeframe);
                } catch (err) {
                    // computeConfluence는 내부에서 이미 삼키지만, 이 조립부가 그 구현
                    // 세부에 의존하지 않게 한 겹 더 막는다. 컨플루언스 실패가 실행 전체를
                    // 중단시키는 일은 없어야 한다.
                    console.warn('[execute] 컨플루언스 계산 실패:', symbol, err);
                }
                confluenceCache.set(symbol, snapshot);
                return snapshot;
            };

            // Weights start from the profile for the timeframe being traded (slow signals
            // count for less the shorter the horizon), then any dashboard-configured value
            // overrides per key — an explicit setting must always win.
            //
            // Merging rather than `?? DEFAULT_WEIGHTS` also matters for correctness: the
            // stored row predates `congress`, so a whole-object fallback would leave that
            // weight `undefined` and make the weighted average NaN. NaN fails both the buy
            // and the sell comparison, so every symbol would silently sit at 'hold' and
            // trading would stop with nothing in the logs.
            const storedWeights = await getConfigValue<Partial<ScoreWeights>>(db, 'score_weights');
            const weights: ScoreWeights = {
                ...weightsForTimeframe(analysisTimeframe),
                ...(storedWeights ?? {}),
            };

            // U.S. market-holiday gating (non-dry-run only). isEtRegularSessionOpen already
            // gated by wall-clock at entry; this catches holidays the static schedule misses.
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
                    finishState = {
                        status: 'skipped',
                        outcome: 'us_market_holiday',
                        ...elapsed(),
                    };
                    return Response.json({ skipped: true, reason: 'us-market-holiday' });
                }
            }

            // AI sizing gate config — read once per run. No row means never configured, and
            // getAnalysisConfig defaults that to enabled, so the gate is live the moment this
            // deploys (design doc §4). Turning it off in 설정 > 분석 설정 restores the old
            // all-or-nothing behavior with no redeploy.
            const gateConfig = await getAnalysisConfig(db, 'trade_gate');
            const gateApiKey = gateConfig.useByok ? resolveApiKey(gateConfig.modelId) : undefined;
            // Hard cutoff at start+600s. The lock TTL is 780s and the audit rows are written
            // after the loops, so a few slow gate calls late in a run must not eat the budget
            // that finalizing the audit needs — past this point we decide without the model.
            const gateDeadlineMs = startedMs + 600_000;

            const watchlistItems = await getEnabledWatchlist(db);

            // Calculate current exposure using current market prices when available,
            // falling back to avgPrice when no analysis data exists.
            const openPositions = await getOpenPositions(db);
            const pendingSubmittedOrders = await getPendingSubmittedOrders(db);

            if (watchlistItems.length === 0 && openPositions.length === 0) {
                finishState = { status: 'skipped', outcome: 'empty_watchlist', ...elapsed() };
                return Response.json({ skipped: true, reason: 'empty_watchlist' });
            }

            let currentExposure = 0;
            for (const p of openPositions) {
                let priceForExposure = safeNumber(Number(p.avgPrice), 0);
                try {
                    const liveExposure = await fetchLivePrice(p.symbol).catch(() => null);
                    if (liveExposure && liveExposure > 0) {
                        priceForExposure = liveExposure;
                    } else {
                        const techForExposure = await getLatestAnalysisResult(
                            db,
                            p.symbol,
                            'technical',
                        );
                        const marketPrice = safeAnalysisPrice(techForExposure?.result);
                        if (marketPrice > 0) priceForExposure = marketPrice;
                    }
                } catch {
                    // Fall back to avgPrice when analysis data is unavailable
                }
                currentExposure += priceForExposure * p.quantity;
            }

            // Track symbols closed by stop-loss in this cron run to prevent immediate re-buy
            const recentStopLossSymbols = new Set<string>();
            // Symbols the re-evaluation loop already sold (fully or partially) this run. The
            // watchlist loop must not sell them again on the same tick: a partial exit leaves
            // a position behind, so a low overall score would otherwise open a *second* sell
            // for the same symbol — same bearish data, two orders, colliding idempotency keys.
            const exitedSymbols = new Set<string>();

            // --- Price cache: batch fetch all needed symbols once ---
            const priceCache = new Map<string, number>();
            const priceFailures = new Map<string, LivePriceDetail>();
            const allSymbols = new Set<string>();
            for (const p of openPositions) allSymbols.add(p.symbol);
            for (const w of watchlistItems) allSymbols.add(w.symbol);
            for (const order of pendingSubmittedOrders) allSymbols.add(order.symbol);
            for (const sym of allSymbols) {
                const detail = await fetchLivePriceDetail(sym).catch((err) => ({
                    source: 'fmp_quote' as const,
                    price: null,
                    reason: 'request_failed' as const,
                    error: err instanceof Error ? err.message : String(err),
                }));
                if (detail.price && detail.price > 0) {
                    priceCache.set(sym, detail.price);
                } else {
                    priceFailures.set(sym, detail);
                }
            }

            let pendingBuyExposure = 0;
            const pendingBuyExposureMissingPrice: string[] = [];
            for (const order of pendingSubmittedOrders) {
                if (
                    order.side !== 'buy' ||
                    !['submitted', 'pending', 'partial'].includes(order.status)
                ) {
                    continue;
                }

                let priceForPending = priceCache.get(order.symbol) ?? 0;
                if (priceForPending <= 0) {
                    try {
                        const techForPending = await getLatestAnalysisResult(
                            db,
                            order.symbol,
                            'technical',
                        );
                        priceForPending = safeAnalysisPrice(techForPending?.result);
                    } catch {
                        priceForPending = 0;
                    }
                }

                if (priceForPending > 0) {
                    pendingBuyExposure += priceForPending * order.quantity;
                } else {
                    pendingBuyExposureMissingPrice.push(order.symbol);
                }
            }
            currentExposure += pendingBuyExposure;

            // USD buying power, fetched once per invocation (auto mode only — guard not used in semi_auto).
            // null => fetch failed — fail CLOSED: all buy orders are skipped until the next run.
            const usdBuyingPower =
                tradingMode === 'auto' ? await getBuyingPower('USD').catch(() => null) : null;
            // Running balance: optimistically decremented after each live buy so multiple
            // buys in one run don't all authorize against the same un-decremented cash.
            // null => guard disabled. Reconcile/next-run corrects against broker reality.
            let remainingBuyingPower: number | null = usdBuyingPower;

            // --- Position re-evaluation ---
            for (const position of openPositions) {
                try {
                    // Skip position if there's a pending submitted sell order
                    const hasPendingSell = pendingSubmittedOrders.some(
                        (o) =>
                            o.symbol === position.symbol &&
                            o.side === 'sell' &&
                            ['submitted', 'pending', 'partial'].includes(o.status),
                    );
                    // semi_auto queues sells in `pending_orders`, not `order_tracking`, so the
                    // in-flight check above cannot see them. Without this a queued approval
                    // that the operator has not acted on yet gets a duplicate queued every
                    // tick. Re-queried per position (not snapshotted) because this same loop
                    // inserts pending sells as it goes.
                    const hasPendingApprovalSell =
                        tradingMode === 'semi_auto' &&
                        (await getPendingOrders(db)).some(
                            (o) =>
                                o.symbol === position.symbol &&
                                o.side === 'sell' &&
                                o.status === 'pending',
                        );
                    if (hasPendingSell || hasPendingApprovalSell) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'pending_sell_in_progress',
                            score: 0,
                        });
                        continue;
                    }

                    const [tech, news, confluence] = await Promise.all([
                        getLatestAnalysisResult(db, position.symbol, 'technical'),
                        getLatestAnalysisResult(db, position.symbol, 'news'),
                        getConfluence(position.symbol),
                    ]);

                    // Staleness check: skip position if technical analysis is too old
                    const techReferenceTime = tech ? getAnalysisReferenceTime(tech) : null;
                    const techAge = techReferenceTime
                        ? Date.now() - techReferenceTime.getTime()
                        : Infinity;
                    const techResult = tech?.result;
                    const currentPrice =
                        priceCache.get(position.symbol) ?? safeAnalysisPrice(techResult);
                    const staleAnalysis = techAge > maxTechnicalAge;

                    // A forced liquidation is driven by the loss limit, not by analysis, so it
                    // must survive missing analysis. This matters because the gate and the
                    // technical cron call the *same* LLM provider: the outage that makes the
                    // gate defer a sell is the same outage that leaves every symbol stale, and
                    // `fixed_exit_enabled` defaults off so no analysis-free stop line exists
                    // either. Bailing on staleness here meant the forced liquidation sold
                    // nothing at the exact moment it was needed.
                    const mechanicalExit = forceFullExit && (staleAnalysis || currentPrice <= 0);

                    if (staleAnalysis && !forceFullExit) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'stale_analysis',
                            score: 0,
                            detail: {
                                timeframe: analysisTimeframe,
                                maxAgeMs: maxTechnicalAge,
                                sourceAnalyzedAt: techReferenceTime?.toISOString() ?? null,
                            },
                        });
                        continue;
                    }

                    // `auto` places a market order, so it can liquidate with no price at all;
                    // dry_run books a fill at `currentPrice` and semi_auto queues a price
                    // limit, so neither can act without one.
                    if (currentPrice <= 0 && !(forceFullExit && tradingMode === 'auto')) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: {
                                ...noPriceDetail(
                                    position.symbol,
                                    priceFailures.get(position.symbol),
                                    techResult,
                                ),
                                forcedLiquidationBlocked: forceFullExit,
                            },
                        });
                        await notifyError(
                            `가격 데이터 없음: ${position.symbol}`,
                            forceFullExit
                                ? `${position.symbol}는 일일 손실 한도 초과로 강제 청산 대상이지만, 현재 가격을 확인할 수 없어 ${tradingMode} 모드에서는 청산하지 못했습니다.${tradingMode === 'dry_run' ? ' (dry_run 시뮬레이션 — 실계좌 포지션이 아닙니다.)' : ' 즉시 수동 확인이 필요합니다.'}`
                                : `${position.symbol} 포지션의 현재 가격을 확인할 수 없어 평가를 건너뛰었습니다. 수동 확인이 필요합니다.`,
                        );
                        continue;
                    }

                    // No stop-loss/take-profit label is invented from analysis we know is
                    // stale (or from a price we don't have) — the whole position goes.
                    const evaluation = mechanicalExit
                        ? {
                              action: 'stop_loss' as const,
                              reason: '일일 손실 한도 초과 — 분석 없이 강제 전량 청산',
                              // Not `hard`: the audit should read `risk_halt` (breaker), not
                              // `hard` (corrupt data / operator stop line).
                              hard: false,
                          }
                        : evaluateExistingPosition({
                              avgPrice: safeNumber(Number(position.avgPrice), 0),
                              currentPrice,
                              stopLossPercent,
                              takeProfitPercent,
                              fixedExitEnabled,
                              supportLevel: safeAnalysisSupport(techResult),
                              resistanceLevel: safeAnalysisResistance(techResult),
                              targetPrice: safeAnalysisTargetPrice(techResult),
                              technicalTrend: safeAnalysisTrend(techResult),
                              newsSentiment: safeAnalysisSentiment(news?.result),
                              // 하락 컨플루언스는 우선순위 3.5 — 추세 반전 뒤, 고정 익절 앞.
                              confluenceExit: isConfluenceExit(confluence),
                          });

                    if (evaluation.action === 'hold') {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'hold',
                            score: 0,
                            executed: false,
                            reason: evaluation.reason,
                        });
                        continue;
                    }

                    // Track stop-loss closures to prevent same-run re-buy. Registered on the
                    // *trigger*, not on how much actually gets sold: a partial stop-loss is
                    // not a safer reason to re-buy the same symbol minutes later — the thesis
                    // that tripped the stop is unchanged either way.
                    if (evaluation.action === 'stop_loss') {
                        recentStopLossSymbols.add(position.symbol);
                    }

                    // --- Exit sizing gate ---
                    // Exits are fail-OPEN: any gate problem sells the full position. Failing to
                    // buy costs an opportunity, failing to sell costs realized money, so a
                    // provider outage must never leave a stop-loss signal holding the bag.
                    const exitTrigger: ExitTrigger =
                        evaluation.action === 'stop_loss' ? 'stop_loss' : 'take_profit';
                    let exitFraction = 1;
                    let exitGateSource: GateSource = 'disabled';
                    let exitOutcome: TradeGateOutcome | null = null;
                    // A tripped loss breaker forces every exit to full size: the whole point
                    // of the breaker is to stop the bleeding, and letting the gate shave the
                    // exit down (or defer it entirely) would defeat it.
                    const hardExit = evaluation.hard === true || forceFullExit;
                    if (forceFullExit && evaluation.hard !== true) {
                        exitGateSource = 'risk_halt';
                    } else if (hardExit) {
                        // Corrupt price data or the operator's fixed stop line — absolute risk
                        // controls, not a call for the model to soften (design doc §6).
                        exitGateSource = 'hard';
                    } else if (!gateConfig.enabled) {
                        exitGateSource = 'disabled';
                    } else if (Date.now() > gateDeadlineMs) {
                        exitGateSource = 'deadline';
                        await notifyError(
                            `게이트 컷오프: ${position.symbol}`,
                            `실행 시작 후 600초를 넘겨 청산 사이징 게이트를 건너뛰고 전량 청산합니다.`,
                        );
                    } else {
                        // The remaining three axes are read only here: on hold / hard-exit /
                        // gate-off paths nothing consumes them, so fetching them up front
                        // would be three wasted queries per position on every tick.
                        const [options, fundamental, congress] = await Promise.all([
                            getLatestAnalysisResult(db, position.symbol, 'options'),
                            getLatestAnalysisResult(db, position.symbol, 'fundamental'),
                            getLatestAnalysisResult(db, position.symbol, 'congress'),
                        ]);
                        // Re-read the day's fill count instead of using the run-start
                        // snapshot: the watchlist loop re-reads it per symbol, and the model
                        // must not see two different "오늘 체결 건수" in one run.
                        const [exitDayCount, exitInflightCount] = await Promise.all([
                            getTodayTradeCount(db),
                            getTodayInflightOrderCount(db),
                        ]);
                        exitOutcome = await runTradeGate({
                            kind: 'exit',
                            symbol: position.symbol,
                            price: currentPrice,
                            priceSource: priceCache.has(position.symbol)
                                ? 'live'
                                : 'analysis_fallback',
                            decidedAt: new Date(),
                            account: {
                                availableCashUsd: remainingBuyingPower,
                                maxPositionSize,
                                symbolExposure: currentPrice * position.quantity,
                                currentExposure,
                                maxTotalExposure,
                                todayRealizedPnl: todayPnl,
                                maxDailyLossUsd: maxDailyLoss,
                                todayTradeCount: exitDayCount + exitInflightCount,
                                maxTradesPerDay,
                                tradingMode,
                            },
                            // This path never scores signals — it re-evaluates a held position.
                            signal: null,
                            position: {
                                quantity: position.quantity,
                                avgPrice: safeNumber(Number(position.avgPrice), 0),
                                // How long it has been held — material to a scale-out call.
                                openedAt: position.openedAt ?? null,
                            },
                            budget: null,
                            exit: { trigger: exitTrigger, ruleReason: evaluation.reason },
                            analyses: toGateAnalyses({
                                // DB row가 아니라 방금 계산한 스냅샷이라 AnalysisRow 형태로
                                // 맞춰 넘긴다. analyzedAt은 마지막 봉 시각(unix seconds).
                                confluence: confluence
                                    ? {
                                          result: confluence,
                                          modelId: 'rule-engine',
                                          analyzedAt: new Date(confluence.barTime * 1000),
                                      }
                                    : null,
                                technical: tech,
                                news,
                                options,
                                fundamental,
                                congress,
                            }),
                            modelId: gateConfig.modelId,
                            userApiKey: gateApiKey,
                            correlationId: `${cronRunId}-${position.symbol}-exit`,
                        });
                        if (exitOutcome.status === 'ok') {
                            exitFraction = exitOutcome.fraction;
                            exitGateSource = 'ai';
                        } else {
                            exitGateSource = 'error';
                            await notifyError(
                                `청산 게이트 실패: ${position.symbol}`,
                                `사이징 게이트 오류로 전량 청산합니다 (fail-open).\n오류: ${exitOutcome.error}`,
                            );
                        }
                    }

                    const exitQty = planExit({
                        positionQuantity: position.quantity,
                        fraction: exitFraction,
                        trigger: exitTrigger,
                        hard: hardExit,
                    });
                    const exitDetail = gateDetail({
                        kind: 'exit',
                        source: exitGateSource,
                        model: gateConfig.modelId,
                        fraction: exitFraction,
                        outcome: exitOutcome,
                        quantity: exitQty,
                    });
                    /**
                     * Audit payload for every exit outcome, including the ones that end
                     * without a trade. Without the gate block on those, "broker rejected it"
                     * is unreconstructable after the fact: how many shares the gate sized and
                     * why are gone.
                     */
                    const exitAudit = (order?: Record<string, unknown>) =>
                        order
                            ? { ...exitDetail, order: { intendedQty: exitQty, ...order } }
                            : exitDetail;

                    if (exitQty === 0) {
                        // fraction 0 is a deliberate "not this tick" call, not a failure — the
                        // position stays open and the next tick re-evaluates. No email.
                        decisions.push({
                            symbol: position.symbol,
                            action: 'exit_deferred',
                            score: 0,
                            executed: false,
                            reason: evaluation.reason,
                            detail: exitDetail,
                        });
                        continue;
                    }

                    // Kill-switch re-check, deliberately AFTER the gate and immediately before
                    // the order: the gate call can block for up to 25s per symbol, and a run
                    // with several positions would otherwise keep firing orders for minutes
                    // after the operator flipped the switch.
                    //
                    // Yes, this blocks liquidation too — unlike the loss breakers above. The
                    // kill switch is not a risk breaker, it is the operator saying "touch
                    // nothing" (e.g. they are about to trade the account by hand), and the
                    // pre-existing contract already halts every order on it.
                    if (!((await getConfigValue<boolean>(db, 'trading_enabled')) ?? true)) {
                        decisions.push({
                            symbol: position.symbol,
                            action: 'trading_disabled_mid_loop',
                            score: 0,
                            detail: exitDetail,
                        });
                        continue;
                    }

                    // Execute the exit
                    exitedSymbols.add(position.symbol);
                    let decisionPushed = false;
                    switch (tradingMode) {
                        case 'dry_run':
                            try {
                                await db.transaction(async (tx) => {
                                    // Partial exits leave the position open — only a full-size
                                    // exit closes it.
                                    if (exitQty >= position.quantity) {
                                        const closed = await closePosition(
                                            tx,
                                            position.id,
                                            currentPrice,
                                        );
                                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                    } else {
                                        // 0 rows matched = the position was closed/shrunk by
                                        // reconcile or a manual close while we were in the
                                        // gate. Booking the trade anyway would leave a sell
                                        // with realized PnL against an untouched position and
                                        // poison the daily-loss breaker's input.
                                        const reduced = await reducePositionQuantity(
                                            tx,
                                            position.id,
                                            exitQty,
                                        );
                                        if (!reduced) throw new Error('POSITION_ALREADY_CLOSED');
                                    }
                                    await insertTrade(tx, {
                                        symbol: position.symbol,
                                        side: 'sell',
                                        orderType: 'market',
                                        quantity: exitQty,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: evaluation.reason,
                                        mode: 'dry_run',
                                        cronRunId,
                                        realizedPnl: realizedPnlForSell(
                                            currentPrice,
                                            Number(position.avgPrice),
                                            exitQty,
                                        ),
                                    });
                                });
                                // A1: notify on dry_run fills, mirroring the auto exit path.
                                // Stop-loss exits honor the 'stop_loss' checkbox; all others
                                // use 'trade_executed' — same routing as the auto branch below.
                                {
                                    const dryExitEvent =
                                        evaluation.action === 'stop_loss'
                                            ? ('stop_loss' as const)
                                            : ('trade_executed' as const);
                                    await dispatcher
                                        .notifyTradeExecuted(
                                            {
                                                symbol: position.symbol,
                                                side: 'sell',
                                                quantity: exitQty,
                                                price: currentPrice,
                                                reason: evaluation.reason,
                                                mode: 'dry_run',
                                            },
                                            dryExitEvent,
                                        )
                                        .catch((err) => console.error('[email] send failed:', err));
                                }
                                currentExposure -= currentPrice * exitQty;
                                if (currentExposure < 0) currentExposure = 0;
                            } catch (txErr) {
                                if (
                                    txErr instanceof Error &&
                                    txErr.message === 'POSITION_ALREADY_CLOSED'
                                ) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'already_closed',
                                        score: 0,
                                        detail: exitAudit({ mode: 'dry_run' }),
                                    });
                                    decisionPushed = true;
                                } else {
                                    throw txErr;
                                }
                            }
                            break;

                        case 'semi_auto':
                            await insertPendingOrder(db, {
                                symbol: position.symbol,
                                side: 'sell',
                                quantity: exitQty,
                                priceLimit: currentPrice,
                                analysisSummary: evaluation.reason,
                                signalScore: 0,
                                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            });
                            await dispatcher
                                .notifyApprovalRequest({
                                    symbol: position.symbol,
                                    side: 'sell',
                                    quantity: exitQty,
                                    score: 0,
                                    reason: evaluation.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            // Pending order awaits human approval — NOT a fill.
                            decisions.push({
                                symbol: position.symbol,
                                action: evaluation.action,
                                score: 0,
                                executed: false,
                                detail: exitDetail,
                            });
                            decisionPushed = true;
                            break;

                        case 'auto': {
                            // Sellable-quantity guard: confirm broker holds enough shares.
                            // Starts from the gate-sized quantity; the broker clamp below can
                            // only shrink it further.
                            let sellQty = exitQty;
                            const sellable = await getSellableQuantity(position.symbol).catch(
                                () => null,
                            );
                            if (sellable != null) {
                                // Clamp first, then reject — a fractional sellable (0<x<1)
                                // floors to 0 and must not produce a 0-qty order.
                                const clamped = Math.min(sellQty, Math.floor(sellable));
                                if (clamped <= 0) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'skipped_not_sellable',
                                        score: 0,
                                        detail: exitAudit({ sellable }),
                                    });
                                    decisionPushed = true;
                                    break;
                                }
                                sellQty = clamped;
                            }
                            // `-reeval-sell` distinguishes this from the watchlist loop's
                            // signal sell: both can fire for one symbol in one run (partial
                            // exit leaves a position behind), and `idempotency_key` is unique.
                            const exitIdempotencyKey = `${cronRunId}-${position.symbol}-reeval-sell`;
                            const clientOrderId = crypto.randomUUID();
                            await createOrderTracking(db, {
                                idempotencyKey: exitIdempotencyKey,
                                clientOrderId,
                                symbol: position.symbol,
                                side: 'sell',
                                quantity: sellQty,
                                status: 'submitted',
                                cronRunId,
                            });
                            let orderResult;
                            try {
                                orderResult = await executeSellOrder(
                                    position.symbol,
                                    sellQty,
                                    clientOrderId,
                                );
                            } catch (apiErr) {
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    status: 'error',
                                    resolvedAt: new Date(),
                                }).catch(() => {});
                                throw apiErr;
                            }
                            // Early status write for non-filled outcomes only. For 'filled' the
                            // ONLY status write happens inside the booking tx (clean fill) or the
                            // needs_review write below — never here — so 'filled' can't exist
                            // without its trade.
                            if (orderResult.status !== 'filled') {
                                const exitResolved =
                                    orderResult.status !== 'pending' &&
                                    orderResult.status !== 'partial';
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    tossOrderId: orderResult.orderId || undefined,
                                    status: orderResult.status,
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: exitResolved ? new Date() : undefined,
                                });
                            }
                            if (
                                orderResult.status === 'rejected' ||
                                orderResult.status === 'canceled'
                            ) {
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'order_rejected',
                                    score: 0,
                                    detail: exitAudit({
                                        submittedQty: sellQty,
                                        status: orderResult.status,
                                        rejectReason: orderResult.rejectReason ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                await notifyError(
                                    `주문 거부: ${position.symbol}`,
                                    orderResult.rejectReason ?? '거부 사유 없음',
                                );
                                break;
                            }
                            // pending/partial: NO trade, NO position mutation, NO exposure change.
                            // Reconcile owns final booking (single source of truth → no double-count).
                            // partial differs only in tracking status + notification text.
                            if (
                                orderResult.status === 'pending' ||
                                orderResult.status === 'partial'
                            ) {
                                if (orderResult.status === 'partial') {
                                    await notifyError(
                                        `부분 체결: ${position.symbol}`,
                                        `${position.symbol} sell ${orderResult.filledQuantity ?? '?'} / ${sellQty}주 부분 체결, 주문ID ${orderResult.orderId ?? 'N/A'}, reconcile가 잔량/최종 체결을 확정합니다.`,
                                    );
                                } else {
                                    await notifyError(
                                        `미체결 주문: ${position.symbol}`,
                                        `${position.symbol} sell ${sellQty}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                                    );
                                }
                                decisions.push({
                                    symbol: position.symbol,
                                    action:
                                        orderResult.status === 'partial'
                                            ? 'order_partial'
                                            : 'order_submitted',
                                    score: 0,
                                    detail: exitAudit({
                                        submittedQty: sellQty,
                                        status: orderResult.status,
                                        filledQuantity: orderResult.filledQuantity ?? null,
                                        orderId: orderResult.orderId ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                break;
                            }
                            // status === 'filled' — auto-book ONLY a clean full fill:
                            // broker filled qty == intended integer qty (within epsilon) AND a
                            // real fill price is present. Any other outcome (short/fractional
                            // fill or missing price) is routed to needs_review (no auto-book).
                            const filledQ = orderResult.filledQuantity ?? sellQty;
                            const cleanFullFill =
                                orderResult.avgFilledPrice != null &&
                                Number.isInteger(sellQty) &&
                                Math.abs(filledQ - sellQty) < 1e-6;
                            if (!cleanFullFill) {
                                // 단축/소수점 체결 또는 체결가 누락 → 자동 기록하지 않고 수동 검토로
                                await updateOrderTracking(db, exitIdempotencyKey, {
                                    status: 'needs_review',
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: new Date(),
                                });
                                await notifyError(
                                    `체결 수동확인 필요: ${position.symbol}`,
                                    `sell 주문이 예상과 다르게 체결됨 (의도 ${sellQty}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                                ).catch((e) => console.error('[email]', e));
                                decisions.push({
                                    symbol: position.symbol,
                                    action: 'needs_review',
                                    score: 0,
                                    detail: exitAudit({
                                        submittedQty: sellQty,
                                        filledQuantity: filledQ,
                                        filledPrice: orderResult.avgFilledPrice ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                break;
                            }
                            const filledSellPrice = orderResult.avgFilledPrice!;
                            const actualExitQty = sellQty;
                            try {
                                await db.transaction(async (tx) => {
                                    if (actualExitQty >= position.quantity) {
                                        const closed = await closePosition(
                                            tx,
                                            position.id,
                                            filledSellPrice,
                                        );
                                        if (!closed) throw new Error('POSITION_ALREADY_CLOSED');
                                    } else {
                                        // See the dry_run branch: a no-match reduce must roll
                                        // the whole booking back, never book a phantom sell.
                                        const reduced = await reducePositionQuantity(
                                            tx,
                                            position.id,
                                            actualExitQty,
                                        );
                                        if (!reduced) throw new Error('POSITION_ALREADY_CLOSED');
                                    }
                                    await insertTrade(tx, {
                                        symbol: position.symbol,
                                        side: 'sell',
                                        orderType: 'market',
                                        quantity: actualExitQty,
                                        price: filledSellPrice,
                                        executedAt: new Date(),
                                        reason: evaluation.reason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                        realizedPnl: realizedPnlForSell(
                                            filledSellPrice,
                                            Number(position.avgPrice),
                                            actualExitQty,
                                        ),
                                    });
                                    // ATOMIC: mark filled inside the same tx so 'filled' never
                                    // exists without its trade (double-book race guard).
                                    await updateOrderTracking(tx, exitIdempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice: filledSellPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                                currentExposure -= filledSellPrice * actualExitQty;
                            } catch (txErr) {
                                if (
                                    txErr instanceof Error &&
                                    txErr.message === 'POSITION_ALREADY_CLOSED'
                                ) {
                                    decisions.push({
                                        symbol: position.symbol,
                                        action: 'already_closed',
                                        score: 0,
                                        detail: exitAudit({
                                            mode: 'auto',
                                            filledQuantity: actualExitQty,
                                            filledPrice: filledSellPrice,
                                        }),
                                    });
                                    decisionPushed = true;
                                    break;
                                }
                                throw txErr;
                            }
                            if (currentExposure < 0) currentExposure = 0;
                            // Route the exit to the matching event: stop-loss closures honor the
                            // 'stop_loss' checkbox, all other exits (take-profit / AI sell) honor
                            // 'trade_executed' — so each checkbox is meaningful on the exit path.
                            {
                                const exitEvent =
                                    evaluation.action === 'stop_loss'
                                        ? ('stop_loss' as const)
                                        : ('trade_executed' as const);
                                await dispatcher
                                    .notifyTradeExecuted(
                                        {
                                            symbol: position.symbol,
                                            side: 'sell',
                                            quantity: actualExitQty,
                                            price: filledSellPrice,
                                            reason: evaluation.reason,
                                            mode: 'auto',
                                        },
                                        exitEvent,
                                    )
                                    .catch((err) => console.error('[email] send failed:', err));
                            }
                            break;
                        }
                    }

                    if (!decisionPushed) {
                        decisions.push({
                            symbol: position.symbol,
                            action: evaluation.action,
                            score: 0,
                            executed: true,
                            detail: exitDetail,
                        });
                    }
                } catch (err) {
                    await notifyError(position.symbol, String(err));
                    decisions.push({ symbol: position.symbol, action: 'error', score: 0 });
                }
            }

            // Recalculate exposure after position closures using cached market prices
            const updatedPositions = await getOpenPositions(db);
            currentExposure = 0;
            for (const p of updatedPositions) {
                let priceForRecalc = safeNumber(Number(p.avgPrice), 0);
                const cachedRecalc = priceCache.get(p.symbol);
                if (cachedRecalc && cachedRecalc > 0) {
                    priceForRecalc = cachedRecalc;
                } else {
                    try {
                        const techForRecalc = await getLatestAnalysisResult(
                            db,
                            p.symbol,
                            'technical',
                        );
                        const recalcPrice = safeAnalysisPrice(techForRecalc?.result);
                        if (recalcPrice > 0) priceForRecalc = recalcPrice;
                    } catch {
                        // Fall back to avgPrice when analysis data is unavailable
                    }
                }
                currentExposure += priceForRecalc * p.quantity;
            }
            currentExposure += pendingBuyExposure;

            // A tripped risk breaker skips the whole watchlist pass — new entries obviously,
            // and signal sells with them: the re-evaluation loop above already had first
            // refusal on every held position (and under a loss breaker sold each in full).
            for (const item of watchlistItems) {
                try {
                    // Gather latest analysis results
                    const [tech, news, options, fundamental, congress, confluence] =
                        await Promise.all([
                            getLatestAnalysisResult(db, item.symbol, 'technical'),
                            getLatestAnalysisResult(db, item.symbol, 'news'),
                            getLatestAnalysisResult(db, item.symbol, 'options'),
                            getLatestAnalysisResult(db, item.symbol, 'fundamental'),
                            getLatestAnalysisResult(db, item.symbol, 'congress'),
                            getConfluence(item.symbol),
                        ]);

                    // Staleness check: skip symbol if technical analysis is too old
                    const techReferenceTime = tech ? getAnalysisReferenceTime(tech) : null;
                    const techAge = techReferenceTime
                        ? Date.now() - techReferenceTime.getTime()
                        : Infinity;
                    if (techAge > maxTechnicalAge) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'stale_analysis',
                            score: 0,
                            detail: {
                                timeframe: analysisTimeframe,
                                maxAgeMs: maxTechnicalAge,
                                sourceAnalyzedAt: techReferenceTime?.toISOString() ?? null,
                            },
                        });
                        continue;
                    }

                    // Score signals — build type-safe inputs from untyped AI results
                    const signalInputs = {
                        confluence,
                        technical: tech?.result
                            ? {
                                  trend: safeAnalysisTrend(tech.result),
                                  riskLevel: safeString(safeRecord(tech.result)?.riskLevel),
                                  actionRecommendation: safeActionRecommendation(tech.result),
                                  indicators: safeAnalysisIndicators(tech.result),
                              }
                            : null,
                        news: news?.result
                            ? {
                                  overallSentiment: safeAnalysisSentiment(news.result),
                              }
                            : null,
                        options: options?.result
                            ? {
                                  signals: safeArray(options.result, 'signals') as
                                      | Array<{ kind?: string }>
                                      | undefined,
                              }
                            : null,
                        fundamental: fundamental?.result
                            ? {
                                  overallSentiment: safeAnalysisSentiment(fundamental.result),
                                  categories: safeFundamentalCategories(fundamental.result),
                              }
                            : null,
                        congress: congress?.result
                            ? { overallSentiment: safeAnalysisSentiment(congress.result) }
                            : null,
                    };
                    const signalScore = scoreSignals(
                        signalInputs,
                        weights,
                        buyThreshold,
                        sellThreshold,
                    );

                    // A tripped breaker blocks new risk only. Signal sells must still get
                    // through: `evaluateExistingPosition` (which the re-evaluation loop runs)
                    // is NOT a superset of the sell signal — it looks at the technical trend
                    // and news sentiment alone, while `scoreSignals` also weighs options,
                    // fundamentals and congress. A position with a neutral trend and a 25/100
                    // composite score holds in that loop, so skipping this one left it with no
                    // exit path at all.
                    if (entryBlock && signalScore.signal !== 'sell') {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_blocked',
                            score: signalScore.total,
                            detail: { entriesBlockedBy: entryBlock.outcome },
                        });
                        continue;
                    }

                    // Position + pricing
                    const existingPosition = await getOpenPositionBySymbol(db, item.symbol);
                    const currentPrice =
                        priceCache.get(item.symbol) ?? safeAnalysisPrice(tech?.result);

                    if (currentPrice <= 0) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: noPriceDetail(
                                item.symbol,
                                priceFailures.get(item.symbol),
                                tech?.result,
                            ),
                        });
                        continue;
                    }

                    // Budget ceiling for this symbol, before the gate applies any fraction.
                    // planEntry folds in the per-symbol cap, the total-exposure cap and (auto
                    // only) real cash, which is why the old average_in-specific cap block that
                    // used to live further down is gone — it was the same arithmetic twice.
                    const existingSymbolExposure = existingPosition
                        ? currentPrice * existingPosition.quantity
                        : 0;
                    const entryPlanInputs = {
                        price: currentPrice,
                        maxPositionSize,
                        maxTotalExposure,
                        currentExposure,
                        existingSymbolExposure,
                        // dry_run/semi_auto never query the broker, so cash is unknown there
                        // (null) and must not constrain the plan.
                        availableCash: remainingBuyingPower,
                    };
                    const maxPlan = planEntry({ ...entryPlanInputs, fraction: 1 });

                    /** Which budget zeroed the plan, in words, for the trade row + email. */
                    const budgetCause = (limitedBy: EntryPlan['limitedBy']) => {
                        if (limitedBy === 'total') {
                            return `최대 노출 한도 초과 (총 노출 $${currentExposure.toFixed(2)} / 한도 $${maxTotalExposure})`;
                        }
                        if (limitedBy === 'cash') {
                            const cash =
                                remainingBuyingPower == null
                                    ? '미상'
                                    : `$${remainingBuyingPower.toFixed(2)}`;
                            return `매수 가능 현금 부족 (현금 ${cash} / 주가 $${currentPrice.toFixed(2)})`;
                        }
                        if (limitedBy === 'symbol') {
                            return `종목당 최대 투자 금액 소진 (이 종목 $${existingSymbolExposure.toFixed(2)} / 한도 $${maxPositionSize})`;
                        }
                        return `예산 산정 불가 (주가 $${currentPrice.toFixed(2)})`;
                    };
                    /** Audit payload for a buy that can't be funded — records the real cause. */
                    const budgetDetail = {
                        limitedBy: maxPlan.limitedBy,
                        fullBudget: maxPlan.fullBudget,
                        price: currentPrice,
                        existingSymbolExposure,
                        currentExposure,
                        maxPositionSize,
                        maxTotalExposure,
                        availableCash: remainingBuyingPower,
                    };
                    /**
                     * Buy signal with a zero budget: skipped-trade row + operator email, the
                     * pre-gate behavior. Used from both the pre-`makeTradeDecision` branch
                     * below and the post-decision 'hold' branch further down.
                     */
                    const recordUnfundedBuy = async () => {
                        const cause = budgetCause(maxPlan.limitedBy);
                        await insertTrade(db, {
                            symbol: item.symbol,
                            side: 'buy',
                            orderType: 'market',
                            quantity: 0,
                            price: currentPrice,
                            executedAt: new Date(),
                            reason: `잔고 부족 — 신호 ${signalScore.total}/100 매수 신호 발생했으나 ${cause}로 미실행`,
                            mode: 'skipped',
                            cronRunId,
                        });
                        await notifyError(
                            `잔고 부족: ${item.symbol}`,
                            `${item.symbol} 매수 신호 (${signalScore.total}/100) 발생했으나 잔고 부족으로 미실행.\n원인: ${cause}\n현재 총 노출: $${currentExposure.toFixed(2)} / 한도: $${maxTotalExposure}`,
                        );
                        decisions.push({
                            symbol: item.symbol,
                            action: 'skipped',
                            score: signalScore.total,
                            detail: {
                                ...scoreDecisionDetail(
                                    signalScore,
                                    buyThreshold,
                                    sellThreshold,
                                    techReferenceTime,
                                    confluence,
                                ),
                                budget: budgetDetail,
                            },
                        });
                    };

                    // A buy signal with no budget left. Handled after the kill switch below,
                    // not here: the alert + skipped-trade row must not fire on a run that
                    // could not have placed an order anyway.
                    const unfundedBuy = signalScore.signal === 'buy' && maxPlan.quantity === 0;

                    // Circuit breaker: re-check daily trade limit before each trade
                    // Include in-flight orders to prevent limit overshoot across concurrent runs.
                    const [currentDayCount, currentInflightCount] = await Promise.all([
                        getTodayTradeCount(db),
                        getTodayInflightOrderCount(db),
                    ]);
                    if (
                        currentDayCount + currentInflightCount >= maxTradesPerDay &&
                        signalScore.signal !== 'sell'
                    ) {
                        // Sells are exempt: the fill limit caps how much new risk is opened,
                        // and refusing to close a position is not a way to trade less.
                        decisions.push({
                            symbol: item.symbol,
                            action: 'daily_limit',
                            score: 0,
                        });
                        continue;
                    }

                    // Make decision
                    let decision = makeTradeDecision({
                        symbol: item.symbol,
                        signalScore,
                        hasOpenPosition: !!existingPosition,
                        positionQuantity: existingPosition?.quantity ?? 0,
                        calculatedSize: maxPlan.quantity,
                    });

                    // Stop-loss cooldown: skip buy signals for symbols closed by stop-loss in
                    // this run. `unfundedBuy` is included because a zero budget makes the
                    // decision 'hold', which would otherwise slip past this guard and mail a
                    // 잔고 부족 alert about a symbol we refuse to buy anyway.
                    if (
                        (decision.action === 'buy' ||
                            decision.action === 'average_in' ||
                            unfundedBuy) &&
                        recentStopLossSymbols.has(item.symbol)
                    ) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'cooldown_after_stop_loss',
                            score: decision.score,
                        });
                        continue;
                    }

                    // Same-tick double-sell guard: the re-evaluation loop already acted on this
                    // symbol. A partial exit leaves the position open, so without this the low
                    // overall score that usually accompanies a stop-loss would fire a *second*
                    // sell for the same symbol on the same tick.
                    if (decision.action === 'sell' && exitedSymbols.has(item.symbol)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'exit_already_handled',
                            score: decision.score,
                        });
                        continue;
                    }

                    // Pending sell guard: skip sell if there's a submitted sell order in flight
                    if (decision.action === 'sell') {
                        const hasPendingSellWatch = pendingSubmittedOrders.some(
                            (o) =>
                                o.symbol === item.symbol &&
                                o.side === 'sell' &&
                                ['submitted', 'pending', 'partial'].includes(o.status),
                        );
                        if (hasPendingSellWatch) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_sell_in_progress',
                                score: decision.score,
                            });
                            continue;
                        }
                    }

                    // Pending buy guard: skip buy/average_in if an in-flight buy order exists
                    // for this symbol. With per-run random clientOrderIds, re-submitting an
                    // unfilled (pending/partial/submitted) buy would double-submit.
                    if (decision.action === 'buy' || decision.action === 'average_in') {
                        const hasPendingBuy = pendingSubmittedOrders.some(
                            (o) =>
                                o.symbol === item.symbol &&
                                o.side === 'buy' &&
                                ['submitted', 'pending', 'partial'].includes(o.status),
                        );
                        if (hasPendingBuy) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_order_in_progress',
                                score: decision.score,
                            });
                            continue;
                        }
                    }

                    // Sell without position guard: no phantom trade when no position exists
                    if (decision.action === 'sell' && !existingPosition) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'no_position_to_sell',
                            score: decision.score,
                        });
                        continue;
                    }

                    if (decision.action === 'hold' && !unfundedBuy) {
                        decisions.push({
                            symbol: item.symbol,
                            action: decision.action,
                            score: decision.score,
                            executed: false,
                            reason: decision.reason,
                            detail: scoreDecisionDetail(
                                signalScore,
                                buyThreshold,
                                sellThreshold,
                                techReferenceTime,
                                confluence,
                            ),
                        });
                        continue;
                    }

                    // Kill switch guard: re-read volatile config before each trade.
                    // trading_mode is snapshot at run start — only the kill switch is re-read
                    // to allow immediate halt without mid-run mode drift.
                    const currentTradingEnabled =
                        (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
                    if (!currentTradingEnabled) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'trading_disabled_mid_loop',
                            score: decision.score,
                        });
                        continue;
                    }

                    // Insufficient budget for a buy signal. A full per-symbol cap is a normal
                    // steady state → quiet `symbol_limit_reached`; any other cause (total
                    // exposure, cash, bad price) gets the skipped-trade row + operator email.
                    if (unfundedBuy) {
                        if (existingPosition && maxPlan.limitedBy === 'symbol') {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'symbol_limit_reached',
                                score: signalScore.total,
                                detail: { budget: budgetDetail },
                            });
                        } else {
                            await recordUnfundedBuy();
                        }
                        continue;
                    }

                    // semi_auto duplicate-approval guard. Must precede the gate: while an
                    // approval sits unanswered this branch fires every tick, and behind the
                    // gate each of those ticks burned a 25s LLM call whose answer was thrown
                    // away.
                    if (tradingMode === 'semi_auto') {
                        const existingPending = (await getPendingOrders(db)).find(
                            (o) => o.symbol === item.symbol && o.status === 'pending',
                        );
                        if (existingPending) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_exists',
                                score: decision.score,
                                detail: scoreDecisionDetail(
                                    signalScore,
                                    buyThreshold,
                                    sellThreshold,
                                    techReferenceTime,
                                    confluence,
                                ),
                            });
                            continue;
                        }
                    }

                    // --- Sizing gate ---
                    // Deliberately last: every rule-engine guard above (stop-loss cooldown,
                    // in-flight orders, phantom sell, kill switch, daily limits, duplicate
                    // approvals) has already run, so an LLM call only happens on a path that
                    // is actually going to place an order.
                    const scoreDetail = scoreDecisionDetail(
                        signalScore,
                        buyThreshold,
                        sellThreshold,
                        techReferenceTime,
                        confluence,
                    );
                    const gateAnalyses = toGateAnalyses({
                        // 재평가 루프와 같은 조립 — DB row가 아니므로 AnalysisRow 형태로 맞춘다.
                        confluence: confluence
                            ? {
                                  result: confluence,
                                  modelId: 'rule-engine',
                                  analyzedAt: new Date(confluence.barTime * 1000),
                              }
                            : null,
                        technical: tech,
                        news,
                        options,
                        fundamental,
                        congress,
                    });
                    const gateAccount = {
                        availableCashUsd: remainingBuyingPower,
                        maxPositionSize,
                        symbolExposure: existingSymbolExposure,
                        currentExposure,
                        maxTotalExposure,
                        todayRealizedPnl: todayPnl,
                        maxDailyLossUsd: maxDailyLoss,
                        todayTradeCount: currentDayCount + currentInflightCount,
                        maxTradesPerDay,
                        tradingMode,
                    };
                    const gateSignal = {
                        total: signalScore.total,
                        totalWithoutConfluence: signalScore.totalWithoutConfluence,
                        signal: signalScore.signal,
                        components: signalScore.components,
                        weights,
                        buyThreshold,
                        sellThreshold,
                        sourceAnalyzedAt: techReferenceTime,
                    };
                    const gatePosition = existingPosition
                        ? {
                              quantity: existingPosition.quantity,
                              avgPrice: safeNumber(Number(existingPosition.avgPrice), 0),
                              // How long it has been held — material to both an add-on and a
                              // scale-out call.
                              openedAt: existingPosition.openedAt ?? null,
                          }
                        : null;
                    const gateCommon = {
                        symbol: item.symbol,
                        companyName: item.companyName ?? undefined,
                        price: currentPrice,
                        priceSource: priceCache.has(item.symbol)
                            ? ('live' as const)
                            : ('analysis_fallback' as const),
                        decidedAt: new Date(),
                        account: gateAccount,
                        signal: gateSignal,
                        position: gatePosition,
                        analyses: gateAnalyses,
                        modelId: gateConfig.modelId,
                        userApiKey: gateApiKey,
                    };

                    let gateAudit: ReturnType<typeof gateDetail> | undefined;

                    if (decision.action === 'buy' || decision.action === 'average_in') {
                        // Entries are fail-CLOSED: no fraction, no order. A missed buy is a
                        // missed opportunity, but committing the full budget on an unverified
                        // signal is real money at risk — the asymmetry is deliberate (§8).
                        let entryFraction = 1;
                        let entrySource: GateSource = 'disabled';
                        let entryOutcome: TradeGateOutcome | null = null;
                        if (gateConfig.enabled) {
                            if (Date.now() > gateDeadlineMs) {
                                await notifyError(
                                    `게이트 컷오프: ${item.symbol}`,
                                    `실행 시작 후 600초를 넘겨 진입 사이징 게이트를 호출하지 못해 매수를 건너뜁니다.`,
                                );
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'gate_skipped_deadline',
                                    score: decision.score,
                                    executed: false,
                                    reason: decision.reason,
                                    detail: {
                                        ...scoreDetail,
                                        ...gateDetail({
                                            kind: 'entry',
                                            source: 'deadline',
                                            model: gateConfig.modelId,
                                            fraction: 0,
                                            outcome: null,
                                            plan: maxPlan,
                                            quantity: 0,
                                        }),
                                    },
                                });
                                continue;
                            }
                            entryOutcome = await runTradeGate({
                                ...gateCommon,
                                kind: 'entry',
                                budget: {
                                    fullBudget: maxPlan.fullBudget,
                                    limitedBy: maxPlan.limitedBy,
                                    maxQuantity: maxPlan.quantity,
                                },
                                exit: null,
                                correlationId: `${cronRunId}-${item.symbol}-entry`,
                            });
                            if (entryOutcome.status === 'ok') {
                                entryFraction = entryOutcome.fraction;
                                entrySource = 'ai';
                            } else {
                                await notifyError(
                                    `진입 게이트 실패: ${item.symbol}`,
                                    `사이징 게이트 오류로 매수를 실행하지 않습니다 (fail-closed).\n오류: ${entryOutcome.error}`,
                                );
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'gate_error',
                                    score: decision.score,
                                    executed: false,
                                    reason: decision.reason,
                                    detail: {
                                        ...scoreDetail,
                                        ...gateDetail({
                                            kind: 'entry',
                                            source: 'error',
                                            model: gateConfig.modelId,
                                            fraction: 0,
                                            outcome: entryOutcome,
                                            plan: maxPlan,
                                            quantity: 0,
                                        }),
                                    },
                                });
                                continue;
                            }
                        }
                        const finalPlan =
                            entryFraction === 1
                                ? maxPlan
                                : planEntry({ ...entryPlanInputs, fraction: entryFraction });
                        gateAudit = gateDetail({
                            kind: 'entry',
                            source: entrySource,
                            model: gateConfig.modelId,
                            fraction: entryFraction,
                            outcome: entryOutcome,
                            plan: finalPlan,
                            quantity: finalPlan.quantity,
                        });
                        if (finalPlan.quantity === 0) {
                            // A deliberate "sit this tick out", not an error — no email.
                            decisions.push({
                                symbol: item.symbol,
                                action: 'entry_deferred',
                                score: decision.score,
                                executed: false,
                                reason: decision.reason,
                                detail: { ...scoreDetail, ...gateAudit },
                            });
                            continue;
                        }
                        decision = { ...decision, quantity: finalPlan.quantity };
                    } else if (decision.action === 'sell' && existingPosition) {
                        // Signal-driven sell — same fail-OPEN policy as the re-evaluation loop.
                        let sellFraction = 1;
                        let sellSource: GateSource = 'disabled';
                        let sellOutcome: TradeGateOutcome | null = null;
                        if (forceFullExit) {
                            // Same contract as the re-evaluation loop: a tripped loss breaker
                            // sells the whole position and never asks the model. This path is
                            // the *only* exit route for a position the rule engine holds and
                            // the composite score wants sold, so leaving the size to the gate
                            // meant a `fraction: 0` could defer it forever with the loss limit
                            // already breached. The call is skipped outright — 25s per symbol
                            // for an answer that is discarded is pure cost.
                            sellSource = 'risk_halt';
                        } else if (gateConfig.enabled && Date.now() > gateDeadlineMs) {
                            sellSource = 'deadline';
                            await notifyError(
                                `게이트 컷오프: ${item.symbol}`,
                                `실행 시작 후 600초를 넘겨 청산 사이징 게이트를 건너뛰고 전량 매도합니다.`,
                            );
                        } else if (gateConfig.enabled) {
                            sellOutcome = await runTradeGate({
                                ...gateCommon,
                                kind: 'exit',
                                budget: null,
                                exit: { trigger: 'signal_sell', ruleReason: decision.reason },
                                correlationId: `${cronRunId}-${item.symbol}-signal-sell`,
                            });
                            if (sellOutcome.status === 'ok') {
                                sellFraction = sellOutcome.fraction;
                                sellSource = 'ai';
                            } else {
                                sellSource = 'error';
                                await notifyError(
                                    `청산 게이트 실패: ${item.symbol}`,
                                    `사이징 게이트 오류로 전량 매도합니다 (fail-open).\n오류: ${sellOutcome.error}`,
                                );
                            }
                        }
                        const sellQty = planExit({
                            positionQuantity: existingPosition.quantity,
                            fraction: sellFraction,
                            trigger: 'signal_sell',
                            hard: forceFullExit,
                        });
                        gateAudit = gateDetail({
                            kind: 'exit',
                            source: sellSource,
                            model: gateConfig.modelId,
                            fraction: sellFraction,
                            outcome: sellOutcome,
                            quantity: sellQty,
                        });
                        if (sellQty === 0) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'exit_deferred',
                                score: decision.score,
                                executed: false,
                                reason: decision.reason,
                                detail: { ...scoreDetail, ...gateAudit },
                            });
                            continue;
                        }
                        decision = { ...decision, quantity: sellQty };
                    }

                    // Kill-switch re-check, AFTER the gate and immediately before the order.
                    // The guard further up runs before a gate call that can block 25s per
                    // symbol, so on a multi-symbol run it leaves minutes in which the operator
                    // has flipped the switch and orders still go out. Sells are stopped too:
                    // the kill switch is not a risk breaker but an explicit "touch nothing",
                    // and halting every order on it is the pre-existing contract.
                    if (!((await getConfigValue<boolean>(db, 'trading_enabled')) ?? true)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'trading_disabled_mid_loop',
                            score: decision.score,
                            detail: { ...scoreDetail, ...(gateAudit ?? {}) },
                        });
                        continue;
                    }

                    // Execute based on mode (snapshot from run start)
                    let decisionPushed = false;
                    /**
                     * Audit payload for every branch below, including the ones that end
                     * without a trade. The gate block has to ride along on those too —
                     * otherwise a broker rejection loses the record of how big the order was
                     * and why the gate sized it that way.
                     */
                    const execAudit = (order?: Record<string, unknown>) => ({
                        ...scoreDetail,
                        ...(gateAudit ?? {}),
                        ...(order ? { order: { intendedQty: decision.quantity, ...order } } : {}),
                    });
                    switch (tradingMode) {
                        case 'dry_run':
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                const dryRunSide = 'buy';
                                const existingDryRun = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: dryRunSide,
                                        orderType: 'market',
                                        quantity: decision.quantity,
                                        price: currentPrice,
                                        executedAt: new Date(),
                                        reason: decision.reason,
                                        mode: 'dry_run',
                                        cronRunId,
                                    });
                                    if (existingDryRun) {
                                        await averageIntoPosition(
                                            tx,
                                            existingDryRun.id,
                                            decision.quantity,
                                            currentPrice,
                                        );
                                    } else {
                                        await openPosition(tx, {
                                            symbol: item.symbol,
                                            side: 'long',
                                            quantity: decision.quantity,
                                            avgPrice: currentPrice,
                                        });
                                    }
                                });
                                // A1: notify on dry_run buy fills, mirroring the auto path.
                                await dispatcher
                                    .notifyTradeExecuted({
                                        symbol: item.symbol,
                                        side: 'buy',
                                        quantity: decision.quantity,
                                        price: currentPrice,
                                        reason: decision.reason,
                                        mode: 'dry_run',
                                    })
                                    .catch((err) => console.error('[email] send failed:', err));
                                currentExposure += currentPrice * decision.quantity;
                            } else if (decision.action === 'sell') {
                                const existingSellPos = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellPos) {
                                    try {
                                        await db.transaction(async (tx) => {
                                            // A gate-sized signal sell can be partial — only a
                                            // full-size sell closes the position (mirrors the
                                            // auto path and the re-evaluation loop).
                                            if (decision.quantity >= existingSellPos.quantity) {
                                                const closed = await closePosition(
                                                    tx,
                                                    existingSellPos.id,
                                                    currentPrice,
                                                );
                                                if (!closed)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            } else {
                                                // A no-match reduce means the position was
                                                // closed/shrunk elsewhere (reconcile, manual
                                                // close) while the gate was running — roll the
                                                // whole booking back rather than record a sell
                                                // that moved nothing.
                                                const reduced = await reducePositionQuantity(
                                                    tx,
                                                    existingSellPos.id,
                                                    decision.quantity,
                                                );
                                                if (!reduced)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            }
                                            await insertTrade(tx, {
                                                symbol: item.symbol,
                                                side: decision.action,
                                                orderType: 'market',
                                                quantity: decision.quantity,
                                                price: currentPrice,
                                                executedAt: new Date(),
                                                reason: decision.reason,
                                                mode: 'dry_run',
                                                cronRunId,
                                                realizedPnl: realizedPnlForSell(
                                                    currentPrice,
                                                    Number(existingSellPos.avgPrice),
                                                    decision.quantity,
                                                ),
                                            });
                                        });
                                        // A1: notify on dry_run sell fills.
                                        await dispatcher
                                            .notifyTradeExecuted({
                                                symbol: item.symbol,
                                                side: 'sell',
                                                quantity: decision.quantity,
                                                price: currentPrice,
                                                reason: decision.reason,
                                                mode: 'dry_run',
                                            })
                                            .catch((err) =>
                                                console.error('[email] send failed:', err),
                                            );
                                        currentExposure -= currentPrice * decision.quantity;
                                        if (currentExposure < 0) currentExposure = 0;
                                    } catch (txErr) {
                                        if (
                                            txErr instanceof Error &&
                                            txErr.message === 'POSITION_ALREADY_CLOSED'
                                        ) {
                                            decisions.push({
                                                symbol: item.symbol,
                                                action: 'already_closed',
                                                score: decision.score,
                                                detail: execAudit({ mode: 'dry_run' }),
                                            });
                                            decisionPushed = true;
                                        } else {
                                            throw txErr;
                                        }
                                    }
                                } else {
                                    // Position disappeared between guard check and execution — skip
                                    decisions.push({
                                        symbol: item.symbol,
                                        action: 'no_position_to_sell',
                                        score: decision.score,
                                        detail: execAudit({ mode: 'dry_run' }),
                                    });
                                    decisionPushed = true;
                                }
                            } else {
                                await insertTrade(db, {
                                    symbol: item.symbol,
                                    side: decision.action,
                                    orderType: 'market',
                                    quantity: decision.quantity,
                                    price: currentPrice,
                                    executedAt: new Date(),
                                    reason: decision.reason,
                                    mode: 'dry_run',
                                    cronRunId,
                                });
                            }
                            break;

                        case 'semi_auto': {
                            // Duplicate-approval guard lives above, ahead of the gate.
                            const pendingSide =
                                decision.action === 'average_in' ? 'buy' : decision.action;
                            await insertPendingOrder(db, {
                                symbol: item.symbol,
                                side: pendingSide,
                                quantity: decision.quantity,
                                priceLimit: currentPrice,
                                analysisSummary: decision.reason,
                                signalScore: decision.score,
                                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                            });
                            // Track pending order exposure to prevent over-allocation
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                currentExposure += currentPrice * decision.quantity;
                            }
                            await dispatcher
                                .notifyApprovalRequest({
                                    symbol: item.symbol,
                                    side: pendingSide,
                                    quantity: decision.quantity,
                                    score: decision.score,
                                    reason: decision.reason,
                                    approveUrl: 'https://auto-trade.siglens.io/pending',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            // Pending order awaits human approval — NOT a fill.
                            decisions.push({
                                symbol: item.symbol,
                                action: decision.action,
                                score: decision.score,
                                executed: false,
                                reason: decision.reason,
                                detail: execAudit({ mode: 'semi_auto', side: pendingSide }),
                            });
                            decisionPushed = true;
                            break;
                        }

                        case 'auto': {
                            const autoSide =
                                decision.action === 'average_in' ? 'buy' : decision.action;
                            const isBuyOrder =
                                decision.action === 'buy' || decision.action === 'average_in';
                            let autoQuantity = decision.quantity;

                            // Buying-power guard (BUY/average_in): fail-closed when buying power is unknown.
                            // If the broker fetch failed (null), skip all buy orders — we cannot verify
                            // there is enough cash. Sells are unaffected (closing exposure is safe).
                            if (isBuyOrder && remainingBuyingPower === null) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'skipped_no_buying_power',
                                    score: decision.score,
                                    executed: false,
                                    detail: execAudit({ availableCash: null }),
                                });
                                decisionPushed = true;
                                break;
                            }
                            // Buying-power guard (BUY/average_in): skip if cost exceeds remaining
                            // USD cash (running balance, decremented after each live buy this run).
                            if (
                                isBuyOrder &&
                                remainingBuyingPower != null &&
                                currentPrice * autoQuantity > remainingBuyingPower
                            ) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'skipped_insufficient_cash',
                                    score: decision.score,
                                    detail: execAudit({
                                        cost: currentPrice * autoQuantity,
                                        availableCash: remainingBuyingPower,
                                    }),
                                });
                                decisionPushed = true;
                                break;
                            }

                            // Sellable-quantity guard (SELL): skip if none sellable, clamp if short.
                            if (decision.action === 'sell') {
                                const sellable = await getSellableQuantity(item.symbol).catch(
                                    () => null,
                                );
                                if (sellable != null) {
                                    // Clamp first, then reject — a fractional sellable (0<x<1)
                                    // floors to 0 and must not produce a 0-qty order.
                                    const clamped = Math.min(autoQuantity, Math.floor(sellable));
                                    if (clamped <= 0) {
                                        decisions.push({
                                            symbol: item.symbol,
                                            action: 'skipped_not_sellable',
                                            score: decision.score,
                                            detail: execAudit({ sellable }),
                                        });
                                        decisionPushed = true;
                                        break;
                                    }
                                    autoQuantity = clamped;
                                }
                            }

                            // `signal-sell` (not bare `sell`) so a partial exit booked by the
                            // re-evaluation loop earlier in this same run cannot collide on
                            // `order_tracking.idempotency_key`.
                            const idempotencyKey =
                                autoSide === 'sell'
                                    ? `${cronRunId}-${item.symbol}-signal-sell`
                                    : `${cronRunId}-${item.symbol}-${autoSide}`;
                            const clientOrderId = crypto.randomUUID();
                            await createOrderTracking(db, {
                                idempotencyKey,
                                clientOrderId,
                                symbol: item.symbol,
                                side: autoSide,
                                quantity: autoQuantity,
                                status: 'submitted',
                                cronRunId,
                            });
                            const orderFn = isBuyOrder ? executeBuyOrder : executeSellOrder;
                            let orderResult;
                            try {
                                orderResult = await orderFn(
                                    item.symbol,
                                    autoQuantity,
                                    clientOrderId,
                                );
                            } catch (apiErr) {
                                await updateOrderTracking(db, idempotencyKey, {
                                    status: 'error',
                                    resolvedAt: new Date(),
                                }).catch(() => {});
                                throw apiErr;
                            }
                            // Early status write for non-filled outcomes only. For 'filled' the
                            // ONLY status write happens inside the booking tx (clean fill) or the
                            // needs_review write below — never here — so 'filled' can't exist
                            // without its trade.
                            if (orderResult.status !== 'filled') {
                                const autoResolved =
                                    orderResult.status !== 'pending' &&
                                    orderResult.status !== 'partial';
                                await updateOrderTracking(db, idempotencyKey, {
                                    tossOrderId: orderResult.orderId || undefined,
                                    status: orderResult.status,
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: autoResolved ? new Date() : undefined,
                                });
                            }
                            if (
                                orderResult.status === 'rejected' ||
                                orderResult.status === 'canceled'
                            ) {
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'order_rejected',
                                    score: decision.score,
                                    detail: execAudit({
                                        submittedQty: autoQuantity,
                                        status: orderResult.status,
                                        rejectReason: orderResult.rejectReason ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                await notifyError(
                                    `주문 거부: ${item.symbol}`,
                                    orderResult.rejectReason ?? '거부 사유 없음',
                                );
                                break;
                            }
                            // Order is live (filled/partial/pending) and will consume cash —
                            // optimistically decrement the running balance so subsequent buys
                            // this run see reduced cash.
                            // For a clean fill we use filledPrice (actual cost); for pending/partial
                            // we use the request price (filled qty unknown at this point).
                            if (isBuyOrder && remainingBuyingPower != null) {
                                const priceForDebit =
                                    orderResult &&
                                    orderResult.status === 'filled' &&
                                    orderResult.avgFilledPrice != null
                                        ? orderResult.avgFilledPrice
                                        : currentPrice;
                                const costActual = priceForDebit * autoQuantity;
                                const costIntended = currentPrice * autoQuantity;
                                if (
                                    orderResult &&
                                    orderResult.status === 'filled' &&
                                    costActual > costIntended * 1.01
                                ) {
                                    console.warn(
                                        '[execute] fill exceeded budget',
                                        item.symbol,
                                        `intended=$${costIntended.toFixed(2)}`,
                                        `actual=$${costActual.toFixed(2)}`,
                                    );
                                }
                                remainingBuyingPower -= costActual;
                            }
                            // pending/partial: NO trade, NO position mutation, NO exposure change.
                            // Reconcile owns final booking (single source of truth → no double-count).
                            // partial differs only in tracking status + notification text.
                            if (
                                orderResult.status === 'pending' ||
                                orderResult.status === 'partial'
                            ) {
                                if (orderResult.status === 'partial') {
                                    await notifyError(
                                        `부분 체결: ${item.symbol}`,
                                        `${item.symbol} ${orderResult.filledQuantity ?? '?'} / ${autoQuantity}주 부분 체결, 주문ID ${orderResult.orderId ?? 'N/A'}, reconcile가 잔량/최종 체결을 확정합니다.`,
                                    );
                                } else {
                                    await notifyError(
                                        `미체결 주문: ${item.symbol}`,
                                        `${item.symbol} ${decision.action} ${autoQuantity}주 주문이 접수되었으나 아직 체결되지 않았습니다. 주문 ID: ${orderResult.orderId ?? 'N/A'}`,
                                    );
                                }
                                decisions.push({
                                    symbol: item.symbol,
                                    action:
                                        orderResult.status === 'partial'
                                            ? 'order_partial'
                                            : 'order_submitted',
                                    score: decision.score,
                                    detail: execAudit({
                                        submittedQty: autoQuantity,
                                        status: orderResult.status,
                                        filledQuantity: orderResult.filledQuantity ?? null,
                                        orderId: orderResult.orderId ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                break;
                            }
                            // status === 'filled' — auto-book ONLY a clean full fill:
                            // broker filled qty == intended integer qty (within epsilon) AND a
                            // real fill price is present. Any other outcome (short/fractional
                            // fill or missing price) is routed to needs_review (no auto-book).
                            const filledQ = orderResult.filledQuantity ?? autoQuantity;
                            const cleanFullFill =
                                orderResult.avgFilledPrice != null &&
                                Number.isInteger(autoQuantity) &&
                                Math.abs(filledQ - autoQuantity) < 1e-6;
                            if (!cleanFullFill) {
                                // 단축/소수점 체결 또는 체결가 누락 → 자동 기록하지 않고 수동 검토로
                                await updateOrderTracking(db, idempotencyKey, {
                                    status: 'needs_review',
                                    filledPrice: orderResult.avgFilledPrice ?? undefined,
                                    resolvedAt: new Date(),
                                });
                                await notifyError(
                                    `체결 수동확인 필요: ${item.symbol}`,
                                    `${autoSide} 주문이 예상과 다르게 체결됨 (의도 ${autoQuantity}주, 체결 ${filledQ}, 체결가 ${orderResult.avgFilledPrice ?? '없음'}). 수동 기록 필요.`,
                                ).catch((e) => console.error('[email]', e));
                                decisions.push({
                                    symbol: item.symbol,
                                    action: 'needs_review',
                                    score: decision.score,
                                    detail: execAudit({
                                        submittedQty: autoQuantity,
                                        filledQuantity: filledQ,
                                        filledPrice: orderResult.avgFilledPrice ?? null,
                                    }),
                                });
                                decisionPushed = true;
                                break;
                            }
                            const filledPrice = orderResult.avgFilledPrice!;
                            const actualQuantity = autoQuantity; // integer, == filledQ
                            const tradeReason = decision.reason;
                            if (decision.action === 'buy' || decision.action === 'average_in') {
                                const existingAuto = await getOpenPositionBySymbol(db, item.symbol);
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: autoSide,
                                        orderType: 'market',
                                        quantity: actualQuantity,
                                        price: filledPrice,
                                        executedAt: new Date(),
                                        reason: tradeReason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                    });
                                    if (existingAuto) {
                                        await averageIntoPosition(
                                            tx,
                                            existingAuto.id,
                                            actualQuantity,
                                            filledPrice,
                                        );
                                    } else {
                                        await openPosition(tx, {
                                            symbol: item.symbol,
                                            side: 'long',
                                            quantity: actualQuantity,
                                            avgPrice: filledPrice,
                                        });
                                    }
                                    // ATOMIC: mark filled inside the same tx so 'filled' never
                                    // exists without its trade (double-book race guard).
                                    await updateOrderTracking(tx, idempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                                currentExposure += filledPrice * actualQuantity;
                            } else if (decision.action === 'sell') {
                                const existingSellPos = await getOpenPositionBySymbol(
                                    db,
                                    item.symbol,
                                );
                                if (existingSellPos) {
                                    try {
                                        await db.transaction(async (tx) => {
                                            if (actualQuantity >= existingSellPos.quantity) {
                                                const closed = await closePosition(
                                                    tx,
                                                    existingSellPos.id,
                                                    filledPrice,
                                                );
                                                if (!closed)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            } else {
                                                // See the dry_run branch — never book a sell
                                                // whose position update matched no rows.
                                                const reduced = await reducePositionQuantity(
                                                    tx,
                                                    existingSellPos.id,
                                                    actualQuantity,
                                                );
                                                if (!reduced)
                                                    throw new Error('POSITION_ALREADY_CLOSED');
                                            }
                                            await insertTrade(tx, {
                                                symbol: item.symbol,
                                                side: autoSide,
                                                orderType: 'market',
                                                quantity: actualQuantity,
                                                price: filledPrice,
                                                executedAt: new Date(),
                                                reason: tradeReason,
                                                mode: 'auto',
                                                cronRunId,
                                                clientOrderId,
                                                realizedPnl: realizedPnlForSell(
                                                    filledPrice,
                                                    Number(existingSellPos.avgPrice),
                                                    actualQuantity,
                                                ),
                                            });
                                            // ATOMIC: mark filled inside the same tx.
                                            await updateOrderTracking(tx, idempotencyKey, {
                                                tossOrderId: orderResult.orderId || undefined,
                                                status: 'filled',
                                                filledPrice,
                                                resolvedAt: new Date(),
                                            });
                                        });
                                        currentExposure -= filledPrice * actualQuantity;
                                        if (currentExposure < 0) currentExposure = 0;
                                    } catch (txErr) {
                                        if (
                                            txErr instanceof Error &&
                                            txErr.message === 'POSITION_ALREADY_CLOSED'
                                        ) {
                                            decisions.push({
                                                symbol: item.symbol,
                                                action: 'already_closed',
                                                score: decision.score,
                                                detail: execAudit({
                                                    mode: 'auto',
                                                    filledQuantity: actualQuantity,
                                                    filledPrice,
                                                }),
                                            });
                                            decisionPushed = true;
                                            break;
                                        }
                                        throw txErr;
                                    }
                                } else {
                                    // Position disappeared between guard check and fill — record trade + alert
                                    await db.transaction(async (tx) => {
                                        await insertTrade(tx, {
                                            symbol: item.symbol,
                                            side: 'sell',
                                            orderType: 'market',
                                            quantity: actualQuantity,
                                            price: filledPrice,
                                            executedAt: new Date(),
                                            reason: `${tradeReason} (포지션 미확인 — 수동 확인 필요)`,
                                            mode: 'auto',
                                            cronRunId,
                                            clientOrderId,
                                        });
                                        // ATOMIC: mark filled inside the same tx.
                                        await updateOrderTracking(tx, idempotencyKey, {
                                            tossOrderId: orderResult.orderId || undefined,
                                            status: 'filled',
                                            filledPrice,
                                            resolvedAt: new Date(),
                                        });
                                    });
                                    await notifyError(
                                        `포지션 미확인 매도 체결: ${item.symbol}`,
                                        `${item.symbol} ${actualQuantity}주가 체결되었으나 DB에 포지션이 없습니다.`,
                                    ).catch((e) => console.error('[email]', e));
                                }
                            } else {
                                await db.transaction(async (tx) => {
                                    await insertTrade(tx, {
                                        symbol: item.symbol,
                                        side: autoSide,
                                        orderType: 'market',
                                        quantity: actualQuantity,
                                        price: filledPrice,
                                        executedAt: new Date(),
                                        reason: tradeReason,
                                        mode: 'auto',
                                        cronRunId,
                                        clientOrderId,
                                    });
                                    // ATOMIC: mark filled inside the same tx.
                                    await updateOrderTracking(tx, idempotencyKey, {
                                        tossOrderId: orderResult.orderId || undefined,
                                        status: 'filled',
                                        filledPrice,
                                        resolvedAt: new Date(),
                                    });
                                });
                            }
                            await dispatcher
                                .notifyTradeExecuted({
                                    symbol: item.symbol,
                                    side: autoSide,
                                    quantity: actualQuantity,
                                    price: filledPrice,
                                    reason: tradeReason,
                                    mode: 'auto',
                                })
                                .catch((err) => console.error('[email] send failed:', err));
                            break;
                        }
                    }

                    if (!decisionPushed) {
                        decisions.push({
                            symbol: item.symbol,
                            action: decision.action,
                            score: decision.score,
                            executed: true,
                            reason: decision.reason,
                            detail: { ...scoreDetail, ...(gateAudit ?? {}) },
                        });
                    }
                } catch (err) {
                    await notifyError(item.symbol, String(err));
                    decisions.push({ symbol: item.symbol, action: 'error', score: 0 });
                }
            }

            const decisionsByAction = decisions.reduce<Record<string, number>>((acc, d) => {
                acc[d.action] = (acc[d.action] ?? 0) + 1;
                return acc;
            }, {});
            finishState = {
                status: 'completed',
                // A run that only liquidated keeps the breaker's outcome so the health view
                // still shows *why* nothing was bought; `exitOnly` says the run did happen.
                outcome: entryBlock ? entryBlock.outcome : 'completed',
                summary: {
                    symbolsEvaluated: decisions.length,
                    decisionsByAction,
                    pendingBuyExposure,
                    pendingBuyExposureMissingPrice,
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
                ...(entryBlock ? { exitOnly: true, entriesBlockedBy: entryBlock.outcome } : {}),
                decisions: decisions.map(publicDecision),
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

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
