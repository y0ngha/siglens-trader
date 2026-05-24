# lib/notification/ — Infrastructure (Email)

Sends email notifications via Resend SDK.

## Files

| File | Responsibility |
|------|---------------|
| `email.ts` | `sendTradeExecutedEmail()`, `sendApprovalRequestEmail()`, `sendErrorEmail()` |

## Notification Events

| Function | When Triggered | Content |
|----------|---------------|---------|
| `sendTradeExecutedEmail` | Trade filled (auto mode) | Symbol, side, qty, price, reason |
| `sendApprovalRequestEmail` | Pending order created (semi_auto mode) | Symbol, side, qty, score, reason, dashboard link |
| `sendErrorEmail` | Unhandled error in cron | Error message |

## Rules

- All emails include the AI's `reason` (judgment basis) so the user can evaluate decision quality.
- Recipient is hardcoded (`dev.y0ngha@gmail.com`) — personal use only.
- `RESEND_API_KEY` env var required. Throws if missing.
- Email failures in cron are caught and don't crash the execution loop.

## Testing

Fully tested with mocked Resend SDK. 100% coverage.
