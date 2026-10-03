/**
 * Morning digest cron — flushes the quiet-hours notification queue.
 *
 * Invoked **every hour** every day (including weekends; US session doesn't gate this).
 * The delivery hour is the operator's setting `config.digest_hour_kst` (default 10),
 * so the schedule can't be a fixed cron line any more:
 *
 * - Before that hour (still quiet hours) the run returns without an audit row.
 * - From that hour on, the first run flushes the queue. A box that was down at the
 *   digest hour still delivers on the next hour instead of a day late, because the
 *   condition is "past the hour", not "exactly the hour".
 * - Once today's digest is done — a `digest` cron_runs row since 00:00 KST that
 *   `completed` (flushed) or was `skipped/queue_empty` (health check ran) — later hourly
 *   runs with an empty queue return without an audit row. So each Seoul day gets exactly
 *   one of: a flush, or a health check — as before, just at the configured hour.
 *   The marker is the audit table, not Redis: a run that was `locked` or `error`
 *   (e.g. a Resend outage) is not "done", so the next hour retries — up to one error row
 *   per hour until the send works, which is the point. Without Redis, `acquireLock`
 *   fails closed and every run after the hour records `skipped/locked` (as every other
 *   cron does when the lock backend is down).
 *
 * Quiet-hours window: 00:00 up to the digest hour KST. The dispatchers read the same
 * setting (`readDigestHour`), so nothing new is queued after the digest has run.
 *
 * If email is disabled: rows are marked sent anyway so the queue stays clear
 * even when the operator has turned off email alerts.
 *
 * If the Resend call throws: rows are left unsent so the next invocation can
 * retry — we prefer "maybe send twice" over "definitely lose".
 *
 * An empty queue does NOT mean an empty run: before going silent the digest checks
 * cron health and sends an alert if the crons are failing or have gone quiet. Silence
 * should mean "nothing happened", never "the system died and nobody noticed".
 */

import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import { readDigestHour } from '../_lib/digest-hour.js';
import { isQuietHours, seoulDayStart } from '../../lib/notification/quiet-hours.js';
import {
    getConfigValue,
    getCronRuns,
    hasDecisionPhaseSince,
    getNotificationConfig,
    getPendingNotifications,
    markNotificationsSent,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
} from '../../lib/db/queries.js';
import type { CronRunFinish } from '../../lib/db/queries.js';
import { sendCronHealthEmail, sendDigestEmail } from '../../lib/notification/email.js';
import { makeEmailGate } from '../../lib/notification/gate.js';
import {
    DECISION_SILENCE_MS,
    SILENCE_THRESHOLD_MS,
    assessCronHealth,
    describeCronHealth,
} from '../../lib/notification/cron-health.js';

const LOCK_KEY = 'cron:digest:lock';
/** TTL well under any reasonable max invocation time; long enough to prevent overlap. */
const LOCK_TTL_S = 300;

export async function GET(req: Request): Promise<Response> {
    if (!verifyCronSecret(req)) {
        return new Response('Unauthorized', { status: 401 });
    }

    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const runId = `digest-${crypto.randomUUID()}`;
    const db = getDb();
    const safe = (p: Promise<unknown>) => p.catch((e) => console.error('[cron-audit]', e));
    const elapsed = () => ({ durationMs: Date.now() - startedMs, finishedAt: new Date() });

    // 시각 게이트. 감사 행보다 **앞** — 다이제스트 시각 전의 매시 호출까지 cron_runs에 남기면 잡음이다.
    if (isQuietHours(startedAt, await readDigestHour(db))) {
        return Response.json({ skipped: true, reason: 'before_digest_hour' });
    }
    // 오늘(서울) 다이제스트가 이미 끝났고 큐가 비었으면 감사 행 없이 끝낸다. 조회 실패는 "아직 안 끝남"
    // 으로 보고 본 경로로 넘긴다 — 거기서 다시 실패하면 오류로 기록된다.
    if ((await digestDoneToday(db, startedAt)) && (await queueIsEmpty(db))) {
        return Response.json({ skipped: true, reason: 'already_ran_today' });
    }

    await safe(finalizeStaleCronRuns(db, startedAt));
    await safe(startCronRun(db, { runId, cronType: 'digest', startedAt }));

    let finishState: CronRunFinish | null = null;
    const lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_S);

    try {
        if (!lockToken) {
            finishState = { status: 'skipped', outcome: 'locked', ...elapsed() };
            return Response.json({ skipped: true, reason: 'locked' });
        }

        const pending = await getPendingNotifications(db);
        const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
        const emailEnabled = emailNotif?.enabled ?? false;

        if (pending.length === 0) {
            const health = await checkHealth(db, startedAt, emailNotif);
            finishState = {
                status: 'skipped',
                outcome: 'queue_empty',
                summary: health.issues.length ? { healthIssues: health.issues.length } : undefined,
                ...elapsed(),
            };
            return Response.json({ skipped: true, reason: 'queue_empty', ...health.response });
        }

        const ids = pending.map((r) => r.id);

        if (!emailEnabled) {
            // Email is off — drain the queue silently so it doesn't accumulate indefinitely.
            await markNotificationsSent(db, ids);
            finishState = {
                status: 'completed',
                outcome: 'completed',
                summary: { sent: 0, drained: pending.length },
                ...elapsed(),
            };
            return Response.json({ drained: pending.length, emailEnabled: false });
        }

        // Compose and send one digest email for all queued rows.
        // If send throws, leave rows unsent so the next run can retry.
        const rows = pending.map((r) => ({
            subject: r.subject,
            html: r.html,
            kind: r.kind,
            createdAt: r.createdAt,
        }));
        await sendDigestEmail(rows, emailNotif?.target ?? undefined);

        await markNotificationsSent(db, ids);
        finishState = {
            status: 'completed',
            outcome: 'completed',
            summary: { sent: pending.length },
            ...elapsed(),
        };
        return Response.json({ sent: pending.length });
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
        }
    }
}

/**
 * Did a digest run already finish its job today (Seoul day)? `completed` = flushed the queue,
 * `skipped/queue_empty` = ran the health check. `locked`/`error` runs did not, so they don't count.
 */
async function digestDoneToday(db: ReturnType<typeof getDb>, now: Date): Promise<boolean> {
    try {
        const runs = await getCronRuns(db, {
            cronType: 'digest',
            from: seoulDayStart(now),
            limit: 50,
        });
        return runs.some(
            (r) =>
                r.status === 'completed' || (r.status === 'skipped' && r.outcome === 'queue_empty'),
        );
    } catch {
        return false;
    }
}

async function queueIsEmpty(db: ReturnType<typeof getDb>): Promise<boolean> {
    try {
        return (await getPendingNotifications(db)).length === 0;
    } catch {
        return false;
    }
}

/**
 * Look for failing or stalled crons and alert when found.
 *
 * Gated on the `cron_health` event so the dashboard toggle actually turns it off —
 * and on the master email switch, since "email OFF" must mean silence. Never throws:
 * a health check that breaks the digest would be worse than the blind spot it closes.
 */
async function checkHealth(
    db: ReturnType<typeof getDb>,
    now: Date,
    emailNotif: { enabled: boolean; target: string | null; events: string[] } | undefined,
): Promise<{ issues: string[]; response: Record<string, unknown> }> {
    try {
        if (!makeEmailGate(emailNotif)('cron_health')) return { issues: [], response: {} };

        const runs = await getCronRuns(db, {
            from: new Date(now.getTime() - SILENCE_THRESHOLD_MS),
            limit: 500,
        });
        // 판단 단계 검사는 조회 실패 시 생략한다(undefined) — 조회 실패를 "판단 없음"으로 알리면 헛경보다.
        const decisionPhaseSeen = await hasDecisionPhaseSince(
            db,
            new Date(now.getTime() - DECISION_SILENCE_MS),
        ).catch(() => undefined);
        // 킬 스위치가 꺼져 있으면 execute가 판단 단계 전에 의도적으로 빠져나간다 — execute와
        // 같은 방식으로 읽어 no_decision 헛경보를 막는다(스펙 §6, A11).
        const tradingEnabled = (await getConfigValue<boolean>(db, 'trading_enabled')) ?? true;
        const issues = describeCronHealth(
            assessCronHealth(runs, now, decisionPhaseSeen, tradingEnabled),
        );
        if (issues.length === 0) return { issues: [], response: {} };

        await sendCronHealthEmail(issues, emailNotif?.target ?? undefined);
        return { issues, response: { healthAlert: issues } };
    } catch (e) {
        console.error('[cron:digest] health check failed', e);
        return { issues: [], response: {} };
    }
}
