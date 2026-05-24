# lib/notification/ — Infrastructure (Email)

Sends email notifications via Resend SDK.

## Files

| File | Responsibility |
|------|---------------|
| `email.ts` | `sendTradeExecutedEmail()`, `sendApprovalRequestEmail()`, `sendErrorEmail()` |

## Notification Events

| Function | When Triggered | Content |
|----------|---------------|---------|
| `sendTradeExecutedEmail` | Trade filled (auto mode) | Symbol, side, qty, price, reason, mode |
| `sendApprovalRequestEmail` | Pending order created (semi_auto mode) | Symbol, side, qty, score, reason, dashboard link |
| `sendErrorEmail` | Unhandled error in cron, order rejected, balance exceeded | Subject + error details |

## Rules

- All emails include the AI's `reason` (judgment basis) so the user can evaluate decision quality.
- Default recipient is `dev.y0ngha@gmail.com` — personal use only. All functions accept optional `to` parameter.
- `RESEND_API_KEY` env var required. Throws if missing.
- `NOTIFICATION_EMAIL_FROM` defaults to `noreply@siglens.io`.
- Email failures in cron are caught (`.catch(() => {})`) and don't crash the execution loop.
- HTML content is escaped with `escapeHtml()` to prevent XSS.

## Testing

Fully tested with mocked Resend SDK.
