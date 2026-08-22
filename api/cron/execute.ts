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
    insertTradeAudit,
    getDryRunCashFlowUsd,
    insertPendingOrder,
    getPendingOrders,
    getTodayTradeCount,
    getTodayInflightOrderCount,
    getTodayRealizedPnl,
    getLastFillTimeBySymbol,
    getNeedsReviewSymbols,
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
import { getCadenceWindowMs } from '../../lib/analysis/cadence.js';
import {
    formatEntryWindow,
    isWithinEntryWindow,
    parseEntryWindow,
} from '../../lib/strategy/entry-window.js';
import {
    exceedsEntryZone,
    formatEntryZone,
    formatStopRoom,
    hasStopRoom,
    MIN_STOP_ROOM,
} from '../../lib/strategy/entry-zone.js';
import {
    DEFAULT_EXECUTE_INTERVAL_MIN,
    isExecuteTick,
    parseExecuteInterval,
} from '../../lib/strategy/execute-interval.js';
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
import { acquireLockDetailed, releaseLock } from '../../lib/lock.js';
import { isEtRegularSessionOpen } from '@y0ngha/siglens-core';
import { fetchLivePrice, fetchLivePriceDetail } from '../../lib/data/live-price.js';
import type { LivePriceDetail } from '../../lib/data/live-price.js';
import { isFinitePositive, safeNumber } from '../../lib/validation.js';
import {
    safeRecord,
    safeString,
    safeAnalysisTrend,
    safeAnalysisSentiment,
    safeAnalysisSupport,
    safeAnalysisResistance,
    safeAnalysisTargetPrice,
    safeArray,
    safeActionRecommendation,
    safeAnalysisIndicators,
    safeAnalysisPatterns,
    safeAnalysisEntryPrices,
    safeAnalysisStopLoss,
    safeAnalysisTakeProfit,
    safeFundamentalCategories,
} from '../../lib/strategy/safe-extract.js';
import { realizedPnlForSell } from '../../lib/strategy/pnl.js';

type ExecuteDecision = CronDecisionInput & { symbol?: string; score: number };

function noPriceDetail(
    symbol: string,
    livePriceDetail: LivePriceDetail | undefined,
    snapshotPrice: number,
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
            // 종전 라벨은 `technical.keyLevels.currentPrice`였는데 그 필드는 core에 없어
            // 항상 0이었다. 이제 컨플루언스 스냅샷(FMP OHLC 마지막 봉 종가)을 쓴다.
            analysisFallback: {
                source: 'confluence.close',
                price: snapshotPrice,
                usable: snapshotPrice > 0,
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

/**
 * 한 실행이 새 심볼 작업을 시작할 수 있는 마지막 시점 (시작 + 900초).
 *
 * 이 시각을 넘기면 남은 심볼은 `run_deadline`으로 남기고 루프를 빠져나온다. 진행 중이던
 * 호출 하나(최악 브로커 주문 ~135초)가 더 걸려도 실행은 약 1035초 안에 끝나므로 락 TTL
 * 1800초 안쪽에 머문다 — 락이 살아있는 동안에는 다음 틱이 절대 겹치지 않는다.
 */
const RUN_DEADLINE_MS = 900_000;

/** 락 TTL. `RUN_DEADLINE_MS` + 최악 잔여 작업보다 크게 잡는다. */
const LOCK_TTL_SEC = 1800;

/**
 * `dry_run` 모의 계좌의 **초기 예치금** (USD). `config.dry_run_cash_usd`로 덮어쓴다.
 *
 * 잔고가 아니라 시작 자본이다 — 현재 잔고는 여기에 체결 원장의 순현금흐름을 더한 값이고,
 * 그래서 모의 계좌도 손익에 따라 늘고 준다. 값을 바꾸면 과거 체결까지 그 예치금 기준으로
 * 재계산된다(원장은 그대로이므로 손익은 보존된다).
 *
 * 시뮬레이션 전용 — `auto`/`semi_auto`는 브로커 실잔고를 쓴다. 실계좌로 넘어가기 전에 이
 * 값을 실제 예치금과 맞춰 두면 리허설이 그만큼 정확해진다.
 */
const DEFAULT_DRY_RUN_CASH_USD = 5000;

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
    /**
     * 실행이 락 TTL을 넘겨 살아 있으면 다음 틱과 동시 실행된다. 그 전에 멈춘다.
     *
     * 매매 루프뿐 아니라 **그보다 앞선 시세 루프들**도 이 마감을 본다 — FMP가 계속
     * 429를 내면 포지션·워치리스트 시세 조회만으로 락 TTL(1800초)을 넘길 수 있고,
     * 그러면 마감 검사가 있는 루프에 닿기도 전에 두 실행이 겹친다.
     */
    const runDeadlineMs = startedMs + RUN_DEADLINE_MS;
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    /**
     * 게이트 호출 1건의 원문(프롬프트·응답)을 `trade_audit`에 남긴다.
     *
     * **주문 성사 여부와 무관하게, 호출 직후에 쓴다.** 트레이드 행에 매달면 fraction 0·게이트
     * 오류·브로커 거절처럼 주문이 안 나간 호출이 통째로 사라지는데, "왜 안 샀나"를 되짚을 때
     * 필요한 게 정확히 그 행들이다. `cron_decisions`가 run_id+symbol로 묶이는 것과 같은
     * 상관 키를 쓰고, `trades.cron_run_id`도 같은 값을 들고 있어 셋이 한 런에서 조인된다.
     *
     * `safe()`로 감싸는 이유 — 감사 기록 실패가 매매를 막으면 본말전도다.
     */
    const auditGate = (
        outcome: TradeGateOutcome,
        kind: 'entry' | 'exit',
        symbol: string,
        /**
         * 게이트 호출에 쓴 것과 **같은** 값을 넘긴다. `(cron_run_id, symbol, kind)`만으로는
         * 유일하지 않다 — 재평가 청산이 `fraction 0`으로 미뤄지면 `exitedSymbols`에 기록되지
         * 않아 같은 런에서 시그널 매도가 같은 심볼을 다시 게이트에 태울 수 있고, 그러면
         * `kind: 'exit'` 행이 두 개가 되어 문서화된 조인이 팬아웃한다.
         */
        correlationId: string,
    ) => {
        // **await하지 않는다.** 이 호출은 게이트 응답과 주문 사이에 있고, 청산 경로에서는
        // 그 사이가 곧 손절이 나가기까지의 지연이다. Neon HTTP 쓰기가 한 번 늘어지면
        // 감사 로그 한 줄 때문에 리스크 축소가 밀린다 — 원칙 7이 막으라는 방향이다.
        // 프로세스는 장수 서버라 응답 이후에도 프라미스는 그대로 완주한다.
        //
        // `safe()`가 아니라 async IIFE + try/catch인 이유: `safe()`는 **이미 만들어진
        // Promise**만 받으므로 `insertTradeAudit(...)` 호출이 동기적으로 던지면 그대로
        // 빠져나가 심볼 루프의 catch에 걸린다 — 감사 기록 실패가 매매를 죽이는, 이 함수가
        // 막으려던 바로 그 일이다. IIFE 안의 try/catch는 동기 throw와 rejection을 같이 잡는다.
        void (async () => {
            try {
                await insertTradeAudit(db, {
                    symbol,
                    kind,
                    modelId: outcome.model,
                    systemPrompt: outcome.transcript.systemPrompt,
                    userPrompt: outcome.transcript.userPrompt,
                    rawResponse: outcome.transcript.rawResponse,
                    status: outcome.status,
                    gateError: outcome.status === 'error' ? outcome.error : undefined,
                    fraction: outcome.status === 'ok' ? outcome.fraction : undefined,
                    confidence: outcome.status === 'ok' ? outcome.confidence : undefined,
                    cronRunId,
                    correlationId,
                });
            } catch (e) {
                console.error('[cron-audit] trade_audit', symbol, kind, e);
            }
        })();
    };

    // 실행 간격 게이트. node-cron은 5분마다 이 핸들러를 부르고, 실제로 돌지 여부는
    // `execute_interval_min` 설정이 정한다 (`lib/strategy/execute-interval.ts`).
    //
    // 감사 행(startCronRun)보다 **앞**에 둔다: 건너뛴 틱까지 cron_runs에 남기면 60분
    // 설정에서 하루 78행 중 6행만 실제 실행이 되어 감사 로그가 잡음으로 덮인다.
    //
    // 설정 조회가 실패하면 기본값으로 진행한다 — DB 일시 장애 때문에 매매 틱이 통째로
    // 사라지는 쪽이 더 나쁘고, 실제 실행에 들어가면 아래 감사 경로가 오류를 제대로 남긴다.
    // `?force=1`은 수동 트리거용 우회다 (커트오버·디버깅에서 간격과 무관하게 실행).
    const executeInterval = await getConfigValue<unknown>(db, 'execute_interval_min')
        .then(parseExecuteInterval)
        .catch(() => DEFAULT_EXECUTE_INTERVAL_MIN);
    const forceRun = new URL(req.url).searchParams.get('force') === '1';
    if (!forceRun && !isExecuteTick(startedAt, executeInterval)) {
        return Response.json({ skipped: true, reason: 'off_interval', executeInterval });
    }

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
        // 락 TTL은 **한 실행이 걸릴 수 있는 최대 시간보다 커야 한다.** 종전 780초는 이제
        // 존재하지 않는 Vercel `maxDuration`(800초)을 상한으로 가정한 값인데, EC2 Node
        // 서버에는 실행 시간 상한이 없다. FMP가 429를 지속하면(호출당 최악 50초) 한 실행이
        // 20분을 넘길 수 있고, 그 사이 TTL이 만료되면 다음 틱이 락을 새로 잡아 **두 실행이
        // 동시에** 돈다 — 각자 `currentExposure`·매수여력·in-flight 스냅샷을 들고 있으므로
        // 같은 심볼에 주문이 두 번 나간다. 실행 간격이 60분이던 때는 임계값이 3600초라
        // 사실상 도달 불가였고, 10분으로 줄이면서 1200초가 됐다.
        //
        // 그래서 두 가지를 같이 건다: TTL을 아래 하드 데드라인보다 넉넉히 크게 잡고,
        // 실행 자체가 그 데드라인에서 멈추게 한다(`RUN_DEADLINE_MS`). node-cron 쪽에도
        // `noOverlap: true`를 걸어 같은 프로세스에서의 겹침을 한 겹 더 막는다.
        const lock = await acquireLockDetailed(LOCK_KEY, LOCK_TTL_SEC);
        const lockToken = lock.token;
        if (!lockToken) {
            // Redis 장애는 경합이 아니다 — 그 상태가 이어지면 매매 크론이 한 틱도 돌지
            // 않는데 `skipped`로 남기면 침묵 감시(`assessCronHealth`)가 아무 경보도 내지
            // 않는다. `error`로 남겨야 digest가 알린다.
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

            /**
             * 분석 폴백 가격 — 컨플루언스 스냅샷의 마지막 봉 종가.
             *
             * 종전에는 `safeAnalysisPrice(technical.keyLevels.currentPrice)`였는데 그 필드가
             * core에 존재하지 않아 항상 0이었다(= 폴백이 없었고, 25% 시세 교차검증도 죽어
             * 있었다). 봉 종가는 FMP OHLC에서 오므로 quote 엔드포인트와 **다른 경로**이고,
             * 교차검증 주석이 원래 비교하려던 두 소스가 정확히 이 둘이다. 이미 컨플루언스가
             * 심볼당 한 번 계산해 캐시하므로 추가 조회는 없다.
             *
             * 여전히 같은 벤더(FMP)라 심볼 매핑 오류·미조정 분할·통화 혼동은 두 값을 함께
             * 오염시킨다 — 잡는 것은 지배적 실패인 "한 번의 나쁜 호가 틱"이다.
             */
            const snapshotPriceOf = async (symbol: string): Promise<number> => {
                const snapshot = await getConfluence(symbol);
                return snapshot && isFinitePositive(snapshot.close) ? snapshot.close : 0;
            };

            /**
             * 축별 신선도 배수. 케이던스 윈도우의 몇 배까지 투표를 허용하는가.
             *
             * 3배인 이유: 한 번 실패하고 다음 주기에 복구되는 것은 정상 운영이지만, 연속
             * 세 주기를 놓쳤다면 그 축은 고장 났다고 보는 편이 맞다. 뉴스 60분 → 3시간,
             * 펀더멘털·의회 24시간 → 3일.
             */
            const AXIS_STALE_MULTIPLIER = 3;

            /**
             * 낡은 분석 행을 `null`로 떨어뜨린다.
             *
             * 신선도 검사가 technical에만 걸려 있었다. 나머지 네 축은 `getLatestAnalysisResult`가
             * 나이 제한 없이 최신 1행을 돌려주고 그 값이 그대로 투표하므로, 뉴스 cron이
             * FMP 쿼터 소진으로 며칠 죽어 있어도 그때의 강세 판정이 가중치 6으로 계속 표를
             * 던진다. 네 축을 합치면 합성 점수를 최대 31점까지 밀어올릴 수 있다 — 매수 임계값이
             * 70이므로 실제로는 39점짜리 종목이 매수될 수 있다는 뜻이다.
             *
             * `null`은 각 축의 스코어러에서 중립 50(컨플루언스·의회는 기권)으로 처리된다.
             * 낡은 값이 방향을 주장하는 것보다 중립이 낫다.
             */
            const freshOrNull = <T extends { analyzedAt: Date | string } | null>(
                row: T,
                analysisType: string,
            ): T | null => {
                if (!row) return null;
                const window = getCadenceWindowMs(analysisType, analysisTimeframe);
                if (window <= 0) return row;
                const at = getAnalysisReferenceTime(row);
                // 시각을 읽을 수 없으면 낡았다고 **단정하지 않는다** — `analysis_results.analyzed_at`은
                // NOT NULL이라 프로덕션에서는 발생하지 않고, 기술 축의 신선도 가드도 같은 경우
                // 통과시킨다(비교가 NaN이라 false). 한쪽만 엄격하면 규칙이 둘이 된다.
                if (!at || !Number.isFinite(at.getTime())) return row;
                return Date.now() - at.getTime() > window * AXIS_STALE_MULTIPLIER ? null : row;
            };

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
                outcome: 'daily_trade_limit' | 'daily_loss_limit' | 'outside_entry_window';
                body: unknown;
            } | null = null;
            let forceFullExit = false;

            // 진입 시간 창: 개장 직후 변동성과 마감 임밸런스를 피해 조용한 구간에서만
            // 신규 진입을 연다. **진입만** 막는다 — 창 밖에도 포지션 재평가·손절·청산은
            // 그대로 돈다. cron 스케줄을 좁히는 대신 이 방식을 쓴 이유가 그것이다.
            //
            // 리스크 회로차단기보다 **앞에** 둔 이유: 아래 차단기들은 평범한 대입이라
            // 둘 다 해당하면 나중 것이 이긴다. 창 밖인 것보다 손실 한도에 걸린 것이
            // 운영자에게 훨씬 중요한 사실이므로 그쪽이 기록에 남아야 한다.
            //
            // 이메일은 보내지 않는다 — 정상 상태이고 시간당 여러 번 발생한다.
            const entryWindow = parseEntryWindow(await getConfigValue<unknown>(db, 'entry_window'));
            if (!isWithinEntryWindow(new Date(), entryWindow)) {
                entryBlock = {
                    outcome: 'outside_entry_window',
                    body: {
                        skipped: true,
                        reason: 'outside_entry_window',
                        entryWindow: formatEntryWindow(entryWindow),
                        timezone: 'America/New_York',
                    },
                };
            }

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
            const todayPnl = await getTodayRealizedPnl(db, tradingMode);
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
                    if (Date.now() > runDeadlineMs) {
                        // 남은 포지션을 빼면 미실현 손실이 **과소** 집계되어 차단기가 늦게
                        // 걸린다. 다만 이 시점에 실행은 이미 마감을 넘겨 아래 매매 루프가
                        // 전부 `run_deadline`으로 빠지므로, 잘못된 강제청산보다 아무것도 하지
                        // 않는 쪽이 맞다. 다음 틱이 처음부터 다시 잰다.
                        console.warn(
                            '[execute] 미실현 손익 사전점검이 실행 마감으로 잘렸다 — 손실 차단기 입력 불완전',
                        );
                        break;
                    }
                    try {
                        const livePreCheck = await fetchLivePrice(pos.symbol).catch(() => null);

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
                        const snapshotPrice = await snapshotPriceOf(pos.symbol);
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

            // 같은 심볼 재진입 최소 간격. 기본 60분 = 실행 간격이 60분이던 시절의 동작.
            //
            // 실행 간격을 10분으로 줄이면 매수 신호가 살아 있는 한 틱마다 분할 진입이
            // 나가므로, 이 쿨다운이 없으면 한 종목이 `max_trades_per_day`를 하루치 통째로
            // 먹는다. 진입 간격을 실행 간격에서 분리하는 게 목적이고, 0이면 꺼진다.
            const entryCooldownMs =
                ((await getConfigValue<number>(db, 'entry_cooldown_min')) ?? 60) * 60_000;

            // 진입가–손절 레벨 최소 간격. DB에는 퍼센트로 저장하고 여기서 비율로 바꾼다
            // (`stop_loss_percent` 등 나머지 퍼센트 키와 같은 규약).
            //
            // 설정으로 뺀 이유: 이 값이 너무 크면 매수가 **전부** 막히는데, 로그에는
            // `entry_no_stop_room`만 쌓여 "신호가 없는 날"과 구분되지 않는다. 조이거나 푸는
            // 판단이 시장 국면에 따라 바뀌는 값을 재배포 뒤로 숨겨 두면 안 된다.
            // 읽기 실패는 기본값으로 진행한다 — DB 일시 장애로 가드가 조용히 꺼지는(0) 것도,
            // 매수가 통째로 막히는 것도 둘 다 나쁘다.
            const storedStopRoomPct = await getConfigValue<number>(db, 'min_stop_room_pct').catch(
                () => null,
            );
            const minStopRoom =
                typeof storedStopRoomPct === 'number' && Number.isFinite(storedStopRoomPct)
                    ? Math.max(0, storedStopRoomPct) / 100
                    : MIN_STOP_ROOM;

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

            // 브로커 캘린더 확인 (non-dry-run만). 진입부의 `isEtRegularSessionOpen`이
            // siglens-core 0.44부터 NYSE 휴장일·반일장을 반영하므로 예정된 휴장은 이미
            // 거기서 걸린다 — **모든 모드에서**, dry_run 포함. 이 블록에 남은 역할은
            // 예정 외 휴장(국가 애도의 날 등)이다: 규칙으로 유도할 수 없고 core의 목록에
            // 아직 없을 수 있으니, 실주문 경로만은 브로커에게 직접 묻는다.
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
            // Hard cutoff at start+600s. The lock TTL is 1800s and the audit rows are written
            // after the loops, so a few slow gate calls late in a run must not eat the budget
            // that finalizing the audit needs — past this point we decide without the model.
            const gateDeadlineMs = startedMs + 600_000;

            const watchlistItems = await getEnabledWatchlist(db);

            // Calculate current exposure using current market prices when available,
            // falling back to avgPrice when no analysis data exists.
            const openPositions = await getOpenPositions(db);
            const pendingSubmittedOrders = await getPendingSubmittedOrders(db);
            // 장부와 브로커가 어긋난 채 사람 손을 기다리는 심볼 — 신규 진입만 막는다.
            // 조회 실패는 삼킨다(가드가 없으면 종전 동작). 24시간은 reconcile의 복구 조회
            // 창과 같다.
            const needsReviewSymbols = new Set(
                await getNeedsReviewSymbols(db, new Date(startedMs - 86_400_000)).catch((err) => {
                    console.error('[execute] needs_review 조회 실패 — 진입 가드 미적용', err);
                    return [];
                }),
            );

            if (watchlistItems.length === 0 && openPositions.length === 0) {
                finishState = { status: 'skipped', outcome: 'empty_watchlist', ...elapsed() };
                return Response.json({ skipped: true, reason: 'empty_watchlist' });
            }

            /**
             * 포지션의 **투입 원가**. 노출 한도(`max_position_size` / `max_total_exposure`)의
             * 단위는 평가액이 아니라 투자 금액이다.
             *
             * 종전에는 현재가 × 수량이었다. 그러면 가격이 내릴수록 남은 예산이 커진다 —
             * 한도 $1,000에 $100로 10주를 산 뒤 주가가 $50이 되면 평가액이 $500이 되어
             * "예산 $500이 남았다"가 되고, 원가로는 이미 $1,000을 다 쓴 상태인데 10주를
             * 더 살 수 있다. $25에서 또 반복하면 한도 $1,000짜리 종목에 원가 $2,000 이상이
             * 들어간다. 한도가 실제로는 아무것도 한정하지 못했다.
             *
             * 원가 기준이면 그 경로가 산술적으로 닫힌다. 부수 효과로 이 루프의 시세 조회가
             * 통째로 사라진다 — 원가는 DB에 이미 있다.
             */
            const costBasisOf = (p: { avgPrice: unknown; quantity: number }) =>
                safeNumber(Number(p.avgPrice), 0) * p.quantity;

            let currentExposure = 0;
            for (const p of openPositions) {
                currentExposure += costBasisOf(p);
            }

            // Track symbols closed by stop-loss in this cron run to prevent immediate re-buy
            const recentStopLossSymbols = new Set<string>();
            /** 분석이 낡아 평가 자체를 못 한 보유 종목. 실행 끝에 한 통으로 알린다. */
            const stalePositions: string[] = [];
            /**
             * 이 실행에서 포지션을 **줄인** 심볼. 매도 중복 방지(`exitedSymbols`)와 별개로
             * 진입도 막는다 — 부분 익절로 노출이 줄면 그만큼 예산이 풀려, 같은 틱의 워치리스트
             * 루프가 방금 판 종목을 곧바로 추가매수할 수 있다(왕복 수수료 + 체결 한도 2건 소모).
             */
            const reducedSymbols = new Set<string>();
            // Symbols the re-evaluation loop already sold (fully or partially) this run. The
            // watchlist loop must not sell them again on the same tick: a partial exit leaves
            // a position behind, so a low overall score would otherwise open a *second* sell
            // for the same symbol — same bearish data, two orders, colliding idempotency keys.
            const exitedSymbols = new Set<string>();

            // 심볼별 마지막 실체결 시각 (재진입 쿨다운용).
            //
            // 쿨다운 창 안의 실체결만 DB에서 심볼별로 집계한다. 종전에는 `getRecentTrades`
            // 최신 200행을 읽어 메모리에서 `mode:'skipped'`를 걸렀는데, 그 감사 행들이 200
            // 슬롯을 차지해 종목이 여럿이면 진짜 체결이 창 밖으로 밀리고 쿨다운이 조용히
            // 꺼졌다(`recordUnfundedBuy`가 매 틱 종목마다 한 행씩 넣는다).
            // 조회 실패는 삼킨다. 쿨다운은 체결 빈도 제한이지 리스크 통제가 아니라서,
            // 이 쿼리 하나 때문에 실행 전체가 죽으면 **청산 경로까지** 같이 죽는다 —
            // 원칙 7이 막으라는 바로 그 형태다. 이력이 없으면 쿨다운 없이 진행한다.
            //
            // **매수뿐 아니라 매도도 센다.** 종전에는 매수 체결만 봤는데, 그러면 손절 직후
            // 재진입을 전혀 막지 못한다 — 손절이 마지막 매수로부터 쿨다운보다 늦게 일어나면
            // 쿨다운은 이미 만료돼 있고, 유일한 방어인 `recentStopLossSymbols`는 실행 스코프라
            // 다음 틱(기본 10분 뒤)에 초기화된다. 실제로 "손절 10분 뒤 같은 분석으로 재매수"가
            // 가능했다. 매도를 기준에 넣으면 익절 후 재진입도 같이 늦춰지는데, 방금 정리한
            // 종목을 몇 분 만에 되사지 않는 쪽이 맞다.
            let lastTradeAtBySymbol = new Map<string, number>();
            if (entryCooldownMs > 0) {
                lastTradeAtBySymbol = await getLastFillTimeBySymbol(
                    db,
                    new Date(Date.now() - entryCooldownMs),
                ).catch((err) => {
                    console.error('[execute] 최근 체결 조회 실패 — 재진입 쿨다운 미적용', err);
                    return new Map<string, number>();
                });
            }

            // --- Price cache: batch fetch all needed symbols once ---
            const priceCache = new Map<string, number>();
            const priceFailures = new Map<string, LivePriceDetail>();
            const allSymbols = new Set<string>();
            for (const p of openPositions) allSymbols.add(p.symbol);
            for (const w of watchlistItems) allSymbols.add(w.symbol);
            for (const order of pendingSubmittedOrders) allSymbols.add(order.symbol);
            for (const sym of allSymbols) {
                if (Date.now() > runDeadlineMs) {
                    // 남은 심볼은 시세 없이 간다(`skipped_no_price`). 여기서 계속 도는 것은
                    // 락 TTL을 넘겨 다음 틱과 겹치는 것과 같다.
                    console.warn('[execute] 시세 프리페치가 실행 마감으로 잘렸다');
                    break;
                }
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
                // `getPendingSubmittedOrders`가 `INFLIGHT_ORDER_STATUSES`(= `error` 포함)로
                // 이미 걸러 온다. `error`(결말 미확정) 매수도 노출로 세는 것이 핵심 —
                // 브로커가 그 주문을 갖고 있을 수 있어서, 빼면 그만큼 `max_total_exposure`를
                // 넘긴다. 종전에는 여기서 세 상태로 다시 좁혀 그 주문이 빠졌다.
                if (order.side !== 'buy') {
                    continue;
                }

                let priceForPending = priceCache.get(order.symbol) ?? 0;
                if (priceForPending <= 0) {
                    priceForPending = await snapshotPriceOf(order.symbol);
                }

                if (priceForPending > 0) {
                    pendingBuyExposure += priceForPending * order.quantity;
                } else {
                    pendingBuyExposureMissingPrice.push(order.symbol);
                }
            }
            // semi_auto 승인 대기 매수도 노출로 센다.
            //
            // `order_tracking`에는 승인 후에야 행이 생기므로, 대기 중인 매수는 다음 실행의
            // 노출 계산에서 통째로 사라진다. 그러면 매 틱 새 종목에 승인 요청이 쌓이고
            // 운영자가 그걸 다 승인하면 `max_total_exposure`를 몇 배로 초과할 수 있다.
            for (const pending of await getPendingOrders(db)) {
                if (pending.side !== 'buy' || pending.status !== 'pending') continue;
                const limit = safeNumber(Number(pending.priceLimit), 0);
                const priceForApproval = limit > 0 ? limit : (priceCache.get(pending.symbol) ?? 0);
                if (priceForApproval > 0) {
                    pendingBuyExposure += priceForApproval * pending.quantity;
                } else {
                    pendingBuyExposureMissingPrice.push(pending.symbol);
                }
            }
            currentExposure += pendingBuyExposure;

            // USD 매수 가능 현금. 런당 한 번 조회하고, 세 모드 모두 **같은 의미의 숫자**를 낸다.
            //
            // - `auto` / `semi_auto`: 브로커 실잔고. 두 모드 다 실계좌에 주문이 나가므로
            //   (semi_auto는 승인 시점에) 실제 현금으로 사이징해야 한다.
            //   null => 조회 실패. `auto`는 fail CLOSED로 이번 런의 매수를 전부 건너뛴다.
            // - `dry_run`: 모의 계좌 잔고 = 예치금(`dry_run_cash_usd`) + 체결 원장의 순현금흐름.
            //   저장 잔고가 아니라 `trades`에서 도출한다 — 자세한 근거는
            //   {@link getDryRunCashFlowUsd}. 매도가 현금을 되돌려주므로 손익이 그대로 반영되고,
            //   그래서 세 모드의 값이 같은 뜻("지금 쓸 수 있는 돈")을 갖는다.
            //
            // 종전 dry_run은 null이었다. 그 결과 게이트 프롬프트에 "매수 가능 현금: 미상"이
            // 찍혀 사이징의 1차 제약이 모델에게 보이지 않았고, `planEntry`의 현금 클램프도
            // 걸리지 않아 노출 한도까지 쌓는 것을 아무도 막지 않았다.
            const usdBuyingPower =
                tradingMode === 'dry_run'
                    ? Math.max(
                          0,
                          ((await getConfigValue<number>(db, 'dry_run_cash_usd').catch(
                              () => null,
                          )) ?? DEFAULT_DRY_RUN_CASH_USD) +
                              (await getDryRunCashFlowUsd(db).catch(() => 0)),
                      )
                    : await getBuyingPower('USD').catch(() => null);
            // Running balance: optimistically decremented after each live buy so multiple
            // buys in one run don't all authorize against the same un-decremented cash.
            // null => guard disabled. Reconcile/next-run corrects against broker reality.
            let remainingBuyingPower: number | null = usdBuyingPower;

            // --- Position re-evaluation ---
            let deadlineHit = false;
            for (const position of openPositions) {
                if (Date.now() > runDeadlineMs) {
                    deadlineHit = true;
                    decisions.push({
                        symbol: position.symbol,
                        action: 'run_deadline',
                        score: 0,
                    });
                    continue;
                }
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

                    const [tech, newsRow, confluence] = await Promise.all([
                        getLatestAnalysisResult(db, position.symbol, 'technical'),
                        getLatestAnalysisResult(db, position.symbol, 'news'),
                        getConfluence(position.symbol),
                    ]);
                    // 낡은 뉴스가 '뉴스 악재' 청산 분기를 계속 켜 두는 것을 막는다.
                    const news = freshOrNull(newsRow, 'news');

                    // Staleness check: skip position if technical analysis is too old
                    const techReferenceTime = tech ? getAnalysisReferenceTime(tech) : null;
                    const techAge = techReferenceTime
                        ? Date.now() - techReferenceTime.getTime()
                        : Infinity;
                    const techResult = tech?.result;
                    const currentPrice =
                        priceCache.get(position.symbol) ?? (await snapshotPriceOf(position.symbol));
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
                        // 이 경로는 **청산을 통째로 멈춘다** — 손절·익절·구조 훼손 판정이 전부
                        // `evaluateExistingPosition`을 거치기 때문이다. 그런데 분석 cron은
                        // 실패해도 이메일을 보내지 않으므로, 알리지 않으면 운영자는 장중 내내
                        // 포지션이 무평가 상태인 것을 모른다. 유일한 탈출구가 "일일 손실 한도를
                        // 이미 넘겨 강제청산이 켜지는 것"이어서는 안 된다.
                        // 심볼별로 보내면 10분 간격 × 종목 수만큼 쌓이므로 실행당 한 통으로 묶는다.
                        stalePositions.push(
                            `${position.symbol}: 최신 기술분석 ${techReferenceTime?.toISOString() ?? '없음'} (허용 ${Math.round(maxTechnicalAge / 60_000)}분)`,
                        );
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
                                    await snapshotPriceOf(position.symbol),
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
                              // 분석이 명시한 손절/익절가. 여태 사이징 게이트 프롬프트에만
                              // 들어가고 규칙에서는 읽히지 않았다 — `fixed_exit_enabled`가
                              // 기본 꺼짐이라, 명시 손절가가 있는데도 지지선 이탈 같은 간접
                              // 신호가 걸릴 때까지 기다리고 있었다.
                              aiStopLoss: safeAnalysisStopLoss(techResult),
                              aiTakeProfit: safeAnalysisTakeProfit(techResult),
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
                    // 게이트에 넘길 트리거는 `action` 라벨이 아니라 **왜 나가는지**를 따른다.
                    // 지지선 이탈·추세 반전·지표 반전·분석 손절가 이탈은 수익 구간이면
                    // `take_profit`으로 라벨링되는데(손절 이력 오염 방지), 그 라벨을 그대로
                    // 넘기면 프롬프트가 '익절'을 읽고 "목표 달성형이니 일부만 덜어내고
                    // 나머지는 태운다"로 판단한다 — 구조가 깨진 포지션에 정반대 결론이다.
                    const exitTrigger: ExitTrigger = evaluation.structural
                        ? 'structural'
                        : evaluation.action === 'stop_loss'
                          ? 'stop_loss'
                          : 'take_profit';
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
                                // 예산 단위와 같아야 모델이 `## 계좌 상태`와 `## 예산`을
                                // 대조할 수 있다 — 둘이 다른 단위면 숫자가 서로 어긋나 보인다.
                                symbolExposure: costBasisOf(position),
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
                        auditGate(
                            exitOutcome,
                            'exit',
                            position.symbol,
                            `${cronRunId}-${position.symbol}-exit`,
                        );
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
                    reducedSymbols.add(position.symbol);
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
                                // 노출은 원가 단위이므로 판 가격이 아니라 그 주식의 원가만큼 줄인다.
                                currentExposure -=
                                    safeNumber(Number(position.avgPrice), 0) * exitQty;
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
                                // `!= null`만 보면 파싱 실패로 들어온 0이 통과해 체결가 0으로
                                // 기록되고, 매도 전량이 손실로 잡혀 다음 틱에 일일 손실 한도가
                                // 터진다(= 전 종목 강제청산). 양수인지까지 본다.
                                isFinitePositive(orderResult.avgFilledPrice) &&
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
                                // 위와 같은 이유 — 체결가가 아니라 원가만큼 줄인다.
                                currentExposure -=
                                    safeNumber(Number(position.avgPrice), 0) * actualExitQty;
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

            // Recalculate exposure after position closures (cost basis — see `costBasisOf`).
            const updatedPositions = await getOpenPositions(db);
            currentExposure = 0;
            for (const p of updatedPositions) {
                currentExposure += costBasisOf(p);
            }
            currentExposure += pendingBuyExposure;

            // A tripped risk breaker skips the whole watchlist pass — new entries obviously,
            // and signal sells with them: the re-evaluation loop above already had first
            // refusal on every held position (and under a loss breaker sold each in full).
            for (const item of watchlistItems) {
                if (Date.now() > runDeadlineMs) {
                    deadlineHit = true;
                    decisions.push({ symbol: item.symbol, action: 'run_deadline', score: 0 });
                    continue;
                }
                try {
                    // Gather latest analysis results
                    const [techRow, newsRow, optionsRow, fundamentalRow, congressRow, confluence] =
                        await Promise.all([
                            getLatestAnalysisResult(db, item.symbol, 'technical'),
                            getLatestAnalysisResult(db, item.symbol, 'news'),
                            getLatestAnalysisResult(db, item.symbol, 'options'),
                            getLatestAnalysisResult(db, item.symbol, 'fundamental'),
                            getLatestAnalysisResult(db, item.symbol, 'congress'),
                            getConfluence(item.symbol),
                        ]);
                    // technical은 아래에서 자체 신선도 가드(`maxTechnicalAge`)를 거치므로 그대로 둔다.
                    const tech = techRow;
                    const news = freshOrNull(newsRow, 'news');
                    const options = freshOrNull(optionsRow, 'options');
                    const fundamental = freshOrNull(fundamentalRow, 'fundamental');
                    const congress = freshOrNull(congressRow, 'congress');

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
                                  // patternSummaries + strategyResults + candlePatterns.
                                  // core가 방향과 신뢰도 가중치까지 붙여 내는데 여태 미배선이었다.
                                  patterns: safeAnalysisPatterns(tech.result),
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
                            detail: {
                                entriesBlockedBy: entryBlock.outcome,
                                // 어떤 창이었는지 남겨야 사후에 "왜 그날 안 샀나"를 답할 수 있다.
                                ...(entryBlock.outcome === 'outside_entry_window'
                                    ? { entryWindow: formatEntryWindow(entryWindow) }
                                    : {}),
                            },
                        });
                        continue;
                    }

                    // Position + pricing
                    const existingPosition = await getOpenPositionBySymbol(db, item.symbol);
                    const currentPrice =
                        priceCache.get(item.symbol) ?? (await snapshotPriceOf(item.symbol));

                    if (currentPrice <= 0) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'skipped_no_price',
                            score: 0,
                            detail: noPriceDetail(
                                item.symbol,
                                priceFailures.get(item.symbol),
                                await snapshotPriceOf(item.symbol),
                            ),
                        });
                        continue;
                    }

                    // Budget ceiling for this symbol, before the gate applies any fraction.
                    // planEntry folds in the per-symbol cap, the total-exposure cap and (auto
                    // only) real cash, which is why the old average_in-specific cap block that
                    // used to live further down is gone — it was the same arithmetic twice.
                    // 종목 노출도 원가다. 현재가 기준이면 가격이 내릴수록 예산이 늘어난다.
                    const existingSymbolExposure = existingPosition
                        ? costBasisOf(existingPosition)
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

                    // 아래 세 가드가 공통으로 보는 조건 — "이 틱이 신규 위험을 여는가".
                    // `unfundedBuy`가 포함되는 이유: 예산이 0이면 결정이 'hold'로 나오는데,
                    // 그대로 통과시키면 어차피 사지 않을 심볼에 대해 잔고 부족 이메일이 나간다.
                    const isEntryDecision =
                        decision.action === 'buy' ||
                        decision.action === 'average_in' ||
                        unfundedBuy;

                    // Stop-loss cooldown: skip buy signals for symbols closed by stop-loss in
                    // this run.
                    if (isEntryDecision && recentStopLossSymbols.has(item.symbol)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'cooldown_after_stop_loss',
                            score: decision.score,
                        });
                        continue;
                    }

                    // 권장 진입 구간 이탈 — 추격 매수 차단.
                    //
                    // 점수는 분석 신선도 한도(1Hour 기준 2시간) 안이면 같은 분석을 계속 쓴다.
                    // 그래서 분석이 "$150 부근 진입"이라 한 뒤 가격이 $180이 돼도 매수 신호는
                    // 그대로 살아 있고, 시장가로 사면 손절선·목표가만 $150 기준인 포지션이
                    // 생긴다. 상단만 본다 — 구간 아래는 매수에 불리한 방향이 아니다.
                    const entryPrices = safeAnalysisEntryPrices(tech?.result);
                    if (isEntryDecision && exceedsEntryZone(currentPrice, entryPrices)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_out_of_zone',
                            score: decision.score,
                            detail: {
                                price: currentPrice,
                                entryZone: formatEntryZone(entryPrices),
                                entryPrices,
                            },
                        });
                        continue;
                    }

                    // 손절선까지 여유가 없는 진입 차단.
                    //
                    // 위 게이트가 "분석이 말한 구간보다 비싸게 사는가"를 봤다면 이건 "손절선이
                    // 노이즈 대역 밖인가"를 본다. 둘은 서로를 대신하지 못한다 — 실측 3건
                    // (2026-08-19~20, 전건 손실)은 전부 진입 구간 안이면서 손절선까지 여유가
                    // 0.03~0.2%였다. 방향이 틀려서가 아니라 손절선이 스프레드 안이라서 털렸다.
                    const stopLevels = {
                        supportLevel: safeAnalysisSupport(tech?.result),
                        aiStopLoss: safeAnalysisStopLoss(tech?.result),
                    };
                    if (isEntryDecision && !hasStopRoom(currentPrice, stopLevels, minStopRoom)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_no_stop_room',
                            score: decision.score,
                            detail: {
                                price: currentPrice,
                                stopRoom: formatStopRoom(currentPrice, stopLevels),
                                minStopRoom,
                                ...stopLevels,
                            },
                        });
                        continue;
                    }

                    // 분석이 명시적으로 "진입하지 마라"고 한 종목은 사지 않는다.
                    //
                    // 종전에는 `avoid`가 기술 축 감점으로만 표현됐는데, 가중치 8/38을 거치면
                    // 합성 점수에 −2.5점 남짓이라 다른 축이 강하면 그대로 매수가 나갔다.
                    // `entryPrices` 게이트도 이걸 못 잡는다 — core는 `avoid`에서도 "돌파 시
                    // 진입" 같은 **조건부** 구간을 채우도록 강제하고, 그 구간은 대개 현재가
                    // 위쪽이라 상단 검사를 통과한다. 명시적 거부는 점수가 아니라 게이트에서
                    // 처리해야 할 층이다.
                    if (
                        isEntryDecision &&
                        safeActionRecommendation(tech?.result)?.entryRecommendation === 'avoid'
                    ) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_not_recommended',
                            score: decision.score,
                            detail: { entryRecommendation: 'avoid' },
                        });
                        continue;
                    }

                    // 같은 틱에 방금 줄인 포지션은 다시 늘리지 않는다.
                    if (isEntryDecision && reducedSymbols.has(item.symbol)) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_after_exit_blocked',
                            score: decision.score,
                        });
                        continue;
                    }

                    // 재진입 쿨다운 — 실행 간격을 좁혔을 때 한 종목이 하루치 체결 한도를
                    // 통째로 먹는 것을 막는다. 매도에는 걸지 않는다 (원칙 7).
                    const lastTradeAt = lastTradeAtBySymbol.get(item.symbol);
                    if (
                        isEntryDecision &&
                        entryCooldownMs > 0 &&
                        lastTradeAt !== undefined &&
                        Date.now() - lastTradeAt < entryCooldownMs
                    ) {
                        decisions.push({
                            symbol: item.symbol,
                            action: 'entry_cooldown',
                            score: decision.score,
                            detail: {
                                lastTradeAt: new Date(lastTradeAt).toISOString(),
                                cooldownMs: entryCooldownMs,
                            },
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
                    // unfilled buy would double-submit.
                    //
                    // `error`까지 in-flight로 본다(`INFLIGHT_ORDER_STATUSES`). POST 타임아웃이나
                    // 멱등키 충돌은 "브로커가 주문을 받지 않았다"가 아니라 **결말을 모른다**는
                    // 뜻이고, 특히 후자는 이미 갖고 있다는 신호다. 세 상태만 보던 종전 코드는
                    // 그 주문을 없는 셈 치고 다음 틱에 새 clientOrderId로 두 번째 매수를 냈다
                    // (체결이 없으니 `entry_cooldown`도 걸리지 않는다). reconcile이 30분 뒤
                    // 확정할 때까지 매 틱 반복됐다.
                    if (decision.action === 'buy' || decision.action === 'average_in') {
                        const hasPendingBuy = pendingSubmittedOrders.some(
                            (o) => o.symbol === item.symbol && o.side === 'buy',
                        );
                        // 사람이 정리해야 하는 불일치가 남은 심볼도 같은 이유로 막는다:
                        // 브로커에 있는 미기록 주식이 노출 계산에서 빠져 예산이 통째로 다시
                        // 열린다.
                        const needsReview = needsReviewSymbols.has(item.symbol);
                        if (hasPendingBuy || needsReview) {
                            decisions.push({
                                symbol: item.symbol,
                                action: 'pending_order_in_progress',
                                score: decision.score,
                                detail:
                                    needsReview && !hasPendingBuy
                                        ? { needsReview: true }
                                        : undefined,
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
                            auditGate(
                                entryOutcome,
                                'entry',
                                item.symbol,
                                `${cronRunId}-${item.symbol}-entry`,
                            );
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
                            auditGate(
                                sellOutcome,
                                'exit',
                                item.symbol,
                                `${cronRunId}-${item.symbol}-signal-sell`,
                            );
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
                                        // 0행 매칭 = 조회 후 포지션이 닫혔다. 매도 경로와 같이
                                        // 롤백한다 — 그러지 않으면 trade만 남고 포지션이 없어
                                        // 그 주식의 손절선이 영원히 작동하지 않는다.
                                        const merged = await averageIntoPosition(
                                            tx,
                                            existingDryRun.id,
                                            decision.quantity,
                                            currentPrice,
                                        );
                                        if (!merged) throw new Error('POSITION_ALREADY_CLOSED');
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
                                // 모의 잔고도 auto와 같이 런 안에서 차감한다. 그러지 않으면 한
                                // 런의 매수 여러 건이 전부 같은 잔고를 보고 승인돼, 현금 한도가
                                // 종목 수만큼 뻥튀기된다.
                                if (remainingBuyingPower != null) {
                                    remainingBuyingPower = Math.max(
                                        0,
                                        remainingBuyingPower - currentPrice * decision.quantity,
                                    );
                                }
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
                                        // 노출은 원가 단위다 — 재평가 루프와 같이 판 가격이
                                        // 아니라 그 주식의 원가만큼 줄인다. 매도가로 빼면
                                        // 오른 종목을 팔 때 실제보다 크게 차감되어 같은 실행의
                                        // 다음 심볼이 총노출 여유를 과대평가한다.
                                        currentExposure -=
                                            safeNumber(Number(existingSellPos.avgPrice), 0) *
                                            decision.quantity;
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
                                // `!= null`만 보면 파싱 실패로 들어온 0이 통과해 체결가 0으로
                                // 기록되고, 매도 전량이 손실로 잡혀 다음 틱에 일일 손실 한도가
                                // 터진다(= 전 종목 강제청산). 양수인지까지 본다.
                                isFinitePositive(orderResult.avgFilledPrice) &&
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
                                        const merged = await averageIntoPosition(
                                            tx,
                                            existingAuto.id,
                                            actualQuantity,
                                            filledPrice,
                                        );
                                        if (!merged) throw new Error('POSITION_ALREADY_CLOSED');
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
                                        // 위와 같은 이유 — 체결가가 아니라 원가로 차감한다.
                                        currentExposure -=
                                            safeNumber(Number(existingSellPos.avgPrice), 0) *
                                            actualQuantity;
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

            // 실행당 한 통씩. 심볼별로 보내면 10분 간격 × 종목 수만큼 받은편지함이 죽는다.
            if (stalePositions.length > 0) {
                await notifyError(
                    `분석 지연으로 포지션 평가 중단 (${stalePositions.length}종목)`,
                    `아래 보유 종목은 기술분석이 허용 나이를 넘겨 손절·익절 판정을 하지 못했습니다.\n` +
                        `분석 cron 상태를 확인하세요 — 이 상태가 지속되면 청산 경로가 열리지 않습니다.\n\n` +
                        stalePositions.join('\n'),
                );
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
                // A run that only liquidated keeps the breaker's outcome so the health view
                // still shows *why* nothing was bought; `exitOnly` says the run did happen.
                outcome: entryBlock ? entryBlock.outcome : 'completed',
                summary: {
                    symbolsEvaluated: decisions.length,
                    decisionsByAction,
                    pendingBuyExposure,
                    pendingBuyExposureMissingPrice,
                    stalePositions: stalePositions.length,
                    ...(deadlineHit ? { runDeadlineHit: true } : {}),
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
