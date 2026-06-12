# lib/notification/ — Infrastructure (Email)

Sends email notifications via Resend SDK.

## Files

| File | Responsibility |
|------|---------------|
| `email.ts` | `sendTradeExecutedEmail()`, `sendApprovalRequestEmail()`, `sendErrorEmail()` |
| `gate.ts` | `makeEmailGate()` — pure predicate over the `notification_config` email row (master `enabled` + per-event selection). Crons must gate sends through it. |

## Notification Events

| Function | When Triggered | Content |
|----------|---------------|---------|
| `sendTradeExecutedEmail` | Trade filled (auto mode) | Symbol, side, qty, price, reason, mode |
| `sendApprovalRequestEmail` | Pending order created (semi_auto mode) | Symbol, side, qty, score, reason, dashboard link |
| `sendErrorEmail` | Unhandled error in cron, order rejected, balance exceeded | Subject + error details |

## Notification Gating

The dashboard exposes a master ON/OFF toggle plus per-event checkboxes
(`trade_executed`, `order_pending`, `stop_loss`, `error`). Crons fetch the email
`notification_config` row and build a gate via `makeEmailGate(config)`, then guard
every send: `if (shouldEmail('trade_executed')) await sendTradeExecutedEmail(...)`.

- execute cron: approvals → `order_pending` (legacy alias `approval_required`),
  new-trade fills → `trade_executed`, position exits → `trade_executed`/`stop_loss`.
- reconcile cron: all timeout / needs-review / consistency / holdings alerts → `error`.
- `enabled === false` (or a missing row) suppresses **all** email, including safety alerts.
- `updateNotificationConfig` upserts (a bare UPDATE silently no-ops on a missing row,
  which previously made the dashboard toggle look broken).

## Rules

- All emails include the AI's `reason` (judgment basis) so the user can evaluate decision quality.
- Default recipient is `dev.y0ngha@gmail.com` — personal use only. All functions accept optional `to` parameter.
- `RESEND_API_KEY` env var required. Throws if missing.
- `NOTIFICATION_EMAIL_FROM` defaults to `noreply@siglens.io`.
- Email failures in cron are caught (`.catch(() => {})`) and don't crash the execution loop.
- HTML content is escaped with `escapeHtml()` to prevent XSS.

## Testing

Fully tested with mocked Resend SDK.
