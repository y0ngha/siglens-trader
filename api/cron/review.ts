import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import {
    finishCronRun,
    getAnalysisConfig,
    getEnabledWatchlist,
    getLatestAnalysisResult,
    getMrSignalDecisionsSince,
    hasTradeAuditCorrelation,
    insertCronDecisions,
    insertTradeAudit,
    saveAnalysisResult,
    startCronRun,
    finalizeStaleCronRuns,
} from '../../lib/db/queries.js';
import type { CronDecisionInput, CronRunFinish } from '../../lib/db/queries.js';
import { runTechnicalAnalysis } from '../../lib/analysis/run-technical.js';
import { runNewsAnalysis } from '../../lib/analysis/run-news.js';
import { runFundamentalAnalysis } from '../../lib/analysis/run-fundamental.js';
import type { AnalysisRunResult, RunAnalysisOptions } from '../../lib/analysis/types.js';
import {
    extractSourceAnalyzedAt,
    getAnalysisReferenceTime,
} from '../../lib/analysis/source-time.js';
import {
    runEntryReview,
    type ReviewAnalysisEntry,
    type ReviewAnalysisType,
} from '../../lib/analysis/entry-review.js';
import { etDayStart, fetchDailyBars } from '../../lib/analysis/daily-bars.js';
import { acquireLockDetailed, releaseLock } from '../../lib/lock.js';
import { newsCardStore, priorAnalysisStore, resolveApiKey, withDeadline } from './_analysis-io.js';

/**
 * AI 진입 리뷰 크론 — **기록 전용**(docs/specs/2026-09-24-daily-mean-reversion-design.md §5).
 *
 * execute의 판단 단계가 오늘 남긴 신호 결정(`mr_buy`·`mr_skip_*`) 중 아직 리뷰가 없는 것을 골라,
 * 그 종목의 분석(기술 1Day·뉴스·펀더멘털)을 확보하고 AI 판단을 `trade_audit`(kind `entry_review`)에
 * 남긴다. 주문 경로와는 완전히 분리돼 있다 — 이 크론이 죽어도 매매는 그대로 돈다.
 *
 * 멱등 키는 `trade_audit.correlation_id = review-<cron_decisions.id>`다. 리뷰가 실패해도 그 행을
 * 남기므로(status `error`) 같은 신호를 매 틱 다시 부르지 않는다 — 비용 폭주보다 누락 한 건이 낫다.
 */

type ReviewDecision = CronDecisionInput & { symbol?: string; score: number };

/** 한 실행에서 리뷰할 최대 신호 수. 신호당 LLM 호출이 최대 4회다. */
export const MAX_REVIEWS_PER_RUN = 5;
const RUN_DEADLINE_MS = 1_200_000;
const LOCK_KEY = 'cron:review:lock';
const LOCK_TTL_SEC = 1800;
/** 기술 분석은 전략과 같은 일봉으로 한다. */
const REVIEW_TIMEFRAME = '1Day';

const REVIEW_TYPES: readonly ReviewAnalysisType[] = ['technical', 'news', 'fundamental'];
const RUNNERS: Record<ReviewAnalysisType, (o: RunAnalysisOptions) => Promise<AnalysisRunResult>> = {
    technical: runTechnicalAnalysis,
    news: runNewsAnalysis,
    fundamental: runFundamentalAnalysis,
};

/** 판단 단계가 남긴 `detail.mr`에서 리뷰에 쓰는 값만. 없거나 깨졌으면 null. */
function readMr(detail: unknown) {
    const mr = (detail as { mr?: Record<string, unknown> } | null)?.mr;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const price = num(mr?.price);
    const rsi2 = num(mr?.rsi2);
    const sma200 = num(mr?.sma200);
    const sma5 = num(mr?.sma5);
    if (price === null || rsi2 === null || sma200 === null || sma5 === null) return null;
    const spyPrice = num(mr?.spyPrice);
    const spySma200 = num(mr?.spySma200);
    return {
        price,
        rsi2,
        sma200,
        sma5,
        spyUp: spyPrice !== null && spySma200 !== null ? spyPrice > spySma200 : null,
    };
}

async function handler(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const deadlineMs = startedMs + RUN_DEADLINE_MS;
    const db = getDb();
    const since = etDayStart(startedAt);
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    // 대상이 없으면 감사 행 없이 돌아간다 — 신호는 하루 한 번(판단 단계)에만 생긴다.
    const signals = await getMrSignalDecisionsSince(db, since);
    const pending = [];
    for (const d of signals) {
        if (!(await hasTradeAuditCorrelation(db, `review-${d.id}`))) pending.push(d);
    }
    if (pending.length === 0) {
        return Response.json({ skipped: true, reason: 'nothing_pending' });
    }

    const cronRunId = `review-${crypto.randomUUID()}`;
    await safe(finalizeStaleCronRuns(db, startedAt));
    await safe(startCronRun(db, { runId: cronRunId, cronType: 'review', startedAt }));
    let finishState: CronRunFinish | null = null;
    const decisions: ReviewDecision[] = [];

    try {
        const lock = await acquireLockDetailed(LOCK_KEY, LOCK_TTL_SEC);
        if (!lock.token) {
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
            const reviewConfig = await getAnalysisConfig(db, 'entry_review');
            if (!reviewConfig.enabled) {
                finishState = { status: 'skipped', outcome: 'disabled', ...elapsed() };
                return Response.json({ skipped: true, reason: 'disabled' });
            }
            const names = new Map(
                (await getEnabledWatchlist(db)).map((w) => [w.symbol, w.companyName] as const),
            );

            /** 오늘 저장된 분석이 있으면 재사용하고, 없으면 러너로 만들어 저장한다(대시보드 분석 화면용). */
            const ensureAnalysis = async (
                type: ReviewAnalysisType,
                symbol: string,
                companyName: string,
            ): Promise<ReviewAnalysisEntry> => {
                const empty: ReviewAnalysisEntry = {
                    type,
                    result: null,
                    analyzedAt: null,
                    modelId: null,
                };
                try {
                    const latest = await getLatestAnalysisResult(db, symbol, type);
                    if (
                        latest &&
                        latest.analyzedAt >= since &&
                        (type !== 'technical' || latest.timeframe === REVIEW_TIMEFRAME)
                    ) {
                        return {
                            type,
                            result: latest.result,
                            analyzedAt: getAnalysisReferenceTime(latest),
                            modelId: latest.modelId,
                        };
                    }
                    const config = await getAnalysisConfig(db, type);
                    if (!config.enabled) return empty;
                    const result = await withDeadline(
                        RUNNERS[type]({
                            symbol,
                            companyName,
                            modelId: config.modelId as RunAnalysisOptions['modelId'],
                            userApiKey: config.useByok ? resolveApiKey(config.modelId) : undefined,
                            timeframe: REVIEW_TIMEFRAME,
                            cardStore: newsCardStore(db),
                            priorAnalysisStore:
                                type === 'technical' ? priorAnalysisStore(db) : undefined,
                            deadlineMs,
                            reasoning: false,
                        }),
                        deadlineMs - Date.now(),
                    );
                    if (result.status !== 'done' && result.status !== 'cached') {
                        console.warn(
                            '[review] 분석 실패 — 이 축 없이 리뷰한다',
                            symbol,
                            type,
                            result.error,
                        );
                        return empty;
                    }
                    const savedAt = new Date();
                    const sourceAnalyzedAt = extractSourceAnalyzedAt(result.result, savedAt);
                    await saveAnalysisResult(db, {
                        symbol,
                        analysisType: type,
                        result: result.result,
                        modelId: config.modelId,
                        timeframe: REVIEW_TIMEFRAME,
                        analyzedAt: savedAt,
                        sourceAnalyzedAt,
                        cronRunId,
                    });
                    return {
                        type,
                        result: result.result,
                        analyzedAt: sourceAnalyzedAt ?? savedAt,
                        modelId: config.modelId,
                    };
                } catch (err) {
                    console.warn(
                        '[review] 분석 확보 실패 — 이 축 없이 리뷰한다',
                        symbol,
                        type,
                        err,
                    );
                    return empty;
                }
            };

            for (const decision of pending.slice(0, MAX_REVIEWS_PER_RUN)) {
                const symbol = decision.symbol ?? '';
                if (Date.now() > deadlineMs) {
                    decisions.push({ symbol, action: 'run_deadline', score: 0 });
                    continue;
                }
                const correlationId = `review-${decision.id}`;
                try {
                    const mr = readMr(decision.detail);
                    if (!symbol || !mr) {
                        decisions.push({
                            symbol,
                            action: 'review_error',
                            score: 0,
                            reason: 'signal detail unreadable',
                            detail: { decisionId: decision.id },
                        });
                        continue;
                    }
                    const companyName = names.get(symbol) ?? symbol;
                    const [analyses, bars] = await Promise.all([
                        Promise.all(
                            REVIEW_TYPES.map((t) => ensureAnalysis(t, symbol, companyName)),
                        ),
                        fetchDailyBars(symbol, mr.price, startedAt),
                    ]);
                    const closes = bars?.map((b) => b.close) ?? [];
                    const changeOver = (days: number) => {
                        const ref = closes[closes.length - 1 - days];
                        return typeof ref === 'number' && ref > 0
                            ? (mr.price / ref - 1) * 100
                            : null;
                    };
                    const outcome = await runEntryReview({
                        symbol,
                        companyName,
                        decidedAt: decision.createdAt,
                        mr: {
                            ...mr,
                            change1d: changeOver(1),
                            change3d: changeOver(3),
                            change5d: changeOver(5),
                        },
                        executed: decision.action === 'mr_buy' && decision.executed,
                        analyses,
                        modelId: reviewConfig.modelId,
                        userApiKey: reviewConfig.useByok
                            ? resolveApiKey(reviewConfig.modelId)
                            : undefined,
                        correlationId,
                    });
                    // 실패도 남긴다 — 행이 없으면 다음 틱이 같은 신호를 또 부른다.
                    await insertTradeAudit(db, {
                        symbol,
                        kind: 'entry_review',
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
                    decisions.push(
                        outcome.status === 'ok'
                            ? {
                                  symbol,
                                  action: 'reviewed',
                                  score: outcome.fraction,
                                  reason: outcome.reason,
                                  detail: {
                                      decisionId: decision.id,
                                      dropCause: outcome.dropCause,
                                      fraction: outcome.fraction,
                                      confidence: outcome.confidence,
                                      analyses: analyses.map((a) => ({
                                          type: a.type,
                                          present: a.result != null,
                                      })),
                                  },
                              }
                            : {
                                  symbol,
                                  action: 'review_error',
                                  score: 0,
                                  reason: outcome.error,
                                  detail: { decisionId: decision.id },
                              },
                    );
                } catch (err) {
                    console.error('[review] 리뷰 실패', symbol, err);
                    decisions.push({
                        symbol,
                        action: 'error',
                        score: 0,
                        reason: String(err),
                        detail: { decisionId: decision.id },
                    });
                }
            }

            const byAction = decisions.reduce<Record<string, number>>((acc, d) => {
                acc[d.action] = (acc[d.action] ?? 0) + 1;
                return acc;
            }, {});
            finishState = {
                status: 'completed',
                outcome: 'completed',
                summary: {
                    pending: pending.length,
                    processed: Math.min(pending.length, MAX_REVIEWS_PER_RUN),
                    decisionsByAction: byAction,
                },
                ...elapsed(),
            };
            return Response.json({
                cronRunId,
                reviewed: byAction.reviewed ?? 0,
                pending: pending.length,
            });
        } finally {
            await releaseLock(LOCK_KEY, lock.token).catch((e) =>
                console.error('[lock-release]', e),
            );
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
                    'review',
                    decisions.map((d) => ({
                        symbol: d.symbol,
                        action: d.action,
                        score: d.score,
                        executed: false,
                        reason: d.reason,
                        detail: d.detail,
                    })),
                ),
            );
        }
    }
}

export const GET = handler;
