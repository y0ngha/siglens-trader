/**
 * Morning digest cron — flushes the quiet-hours notification queue.
 *
 * Runs at 01:00 UTC (10:00 KST) every day (including weekends; US session
 * doesn't gate this — it's always safe to flush deferred notifications at
 * the start of the Korean business day).
 *
 * Quiet-hours window: 00:00–09:59 KST (15:00–00:59 UTC the same day).
 * The digest fires at 10:00 KST so by definition no notifications are still
 * in quiet hours when this runs.
 *
 * If email is disabled: rows are marked sent anyway so the queue stays clear
 * even when the operator has turned off email alerts.
 *
 * If the Resend call throws: rows are left unsent so the next invocation can
 * retry — we prefer "maybe send twice" over "definitely lose".
 */

import crypto from 'node:crypto';
import { verifyCronSecret } from '../_lib/cron-auth.js';
import { getDb } from '../_lib/db.js';
import { acquireLock, releaseLock } from '../../lib/lock.js';
import {
    getNotificationConfig,
    getPendingNotifications,
    markNotificationsSent,
    startCronRun,
    finishCronRun,
    finalizeStaleCronRuns,
} from '../../lib/db/queries.js';
import type { CronRunFinish } from '../../lib/db/queries.js';
import { sendDigestEmail } from '../../lib/notification/email.js';

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
        if (pending.length === 0) {
            finishState = { status: 'skipped', outcome: 'queue_empty', ...elapsed() };
            return Response.json({ skipped: true, reason: 'queue_empty' });
        }

        const ids = pending.map((r) => r.id);
        const emailNotif = (await getNotificationConfig(db)).find((n) => n.channel === 'email');
        const emailEnabled = emailNotif?.enabled ?? false;

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
