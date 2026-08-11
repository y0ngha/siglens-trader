/**
 * Email notification dispatcher.
 *
 * Single decision point for "send now vs queue for the morning digest":
 *   - Gate check: if the channel / event is disabled, do nothing at all
 *     (no queueing either — "email OFF" means the operator wants silence).
 *   - Quiet-hours check: 00:00–09:59 Asia/Seoul → enqueue via the injected
 *     `enqueue` callback, keeping lib/notification free of any direct DB import.
 *   - Otherwise: send immediately via the email module.
 *
 * The `enqueue` callback is injected by the cron/api layer (pattern mirrors
 * the existing NewsCardStore port), so this module stays I/O-free beyond its
 * Resend dependency.
 */

import type { EmailGate } from './gate.js';
import type { TradeNotification, ApprovalNotification } from './email.js';
import {
    sendTradeExecutedEmail,
    sendApprovalRequestEmail,
    sendErrorEmail,
    buildTradeExecutedEmail,
    buildApprovalRequestEmail,
    buildErrorEmail,
} from './email.js';
import { isQuietHours } from './quiet-hours.js';

export interface EmailDispatcherDeps {
    gate: EmailGate;
    /**
     * Recipient address from the `notification_config` row.
     * Passed as the `to` argument to every send function so the dashboard
     * target setting is honoured. Falls back to the email module's DEFAULT_TO
     * when undefined (row missing or target empty).
     */
    to: string | undefined;
    /**
     * Enqueue a deferred notification row (DB write injected by the cron/api layer).
     * Called only when the gate passes AND it is currently quiet hours.
     * Returns `Promise<unknown>` so callers can pass `enqueueNotification` directly
     * without needing to strip the `.returning()` rows.
     */
    enqueue: (row: { kind: string; subject: string; html: string }) => Promise<unknown>;
    /** Overridable clock — defaults to `() => new Date()`. Useful in tests. */
    now?: () => Date;
}

export interface EmailDispatcher {
    /**
     * Send (or queue) a trade-executed notification.
     * `eventKey` defaults to `'trade_executed'`; pass `'stop_loss'` for stop-loss exits
     * so the operator's event-checkbox selection is honoured correctly.
     */
    notifyTradeExecuted: (
        payload: TradeNotification,
        eventKey?: 'trade_executed' | 'stop_loss',
    ) => Promise<void>;
    /** Send (or queue) an order-pending approval request. */
    notifyApprovalRequest: (payload: ApprovalNotification) => Promise<void>;
    /** Send (or queue) a system error notification. */
    notifyError: (subject: string, body: string) => Promise<void>;
}

export function createEmailDispatcher(deps: EmailDispatcherDeps): EmailDispatcher {
    const now = deps.now ?? (() => new Date());

    /**
     * Core dispatch: check gate, then quiet-hours, then send or enqueue.
     * `eventKeys` are passed to the gate (the gate returns true if ANY key matches
     * the configured event set — supports the legacy 'approval_required' alias).
     */
    async function dispatch(
        eventKeys: string[],
        kind: string,
        build: () => { subject: string; html: string },
        send: () => Promise<void>,
    ): Promise<void> {
        if (!deps.gate(...eventKeys)) return;
        if (isQuietHours(now())) {
            const { subject, html } = build();
            await deps.enqueue({ kind, subject, html });
        } else {
            await send();
        }
    }

    return {
        notifyTradeExecuted: (payload, eventKey = 'trade_executed') =>
            dispatch(
                [eventKey],
                eventKey,
                () => buildTradeExecutedEmail(payload),
                () => sendTradeExecutedEmail(payload, deps.to),
            ),

        notifyApprovalRequest: (payload) =>
            dispatch(
                ['order_pending', 'approval_required'],
                'order_pending',
                () => buildApprovalRequestEmail(payload),
                () => sendApprovalRequestEmail(payload, deps.to),
            ),

        notifyError: (subject, body) =>
            dispatch(
                ['error'],
                'error',
                () => buildErrorEmail(subject, body),
                () => sendErrorEmail(subject, body, deps.to),
            ),
    };
}
