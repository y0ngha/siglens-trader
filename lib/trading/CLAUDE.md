# lib/trading/ — Infrastructure (Toss Securities API)

HTTP client for order execution via Toss Securities Open API.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `TossOrderRequest`, `TossOrderResponse` (status: filled/submitted/rejected, filledQuantity), `TossBalance` |
| `toss-client.ts` | Core HTTP client: `submitOrder()`, `getBalances()`. Retry policy + idempotency key support. |
| `order.ts` | Convenience wrappers: `executeBuyOrder()`, `executeSellOrder()`. Input validation (positive integer quantity, non-empty symbol). Accepts optional `idempotencyKey` parameter. |

## Current Status

**Placeholder.** The Toss Securities Open API is not yet available. The interfaces and endpoint structure are provisional and will be updated when the API documentation is released.

### TODO comments in toss-client.ts:
- Replace endpoint/auth/response format when Toss API opens
- Implement OAuth2 token refresh
- Add `getOrderStatus(orderId)` for reconciliation cron
- Add `cancelOrder(orderId)` for unfilled order cancellation
- Hook `getBalances()` into reconciliation cron for broker-DB consistency

## Retry Policy

- **GET requests**: Up to 2 retries on 5xx errors with exponential backoff (1s, 2s)
- **POST requests (order submission)**: **Never retried** to prevent double execution
- All requests have 10-second timeout (`AbortSignal.timeout`)

## Idempotency

Order functions accept an optional `idempotencyKey` parameter, passed as `X-Idempotency-Key` header to the broker API. The execute cron generates keys in the format `{cronRunId}-{symbol}-{side}` to prevent duplicate orders.

## Rules

- This layer is ONLY called when `trading_mode === 'auto'`.
- In `dry_run` mode, this layer is completely bypassed.
- In `semi_auto` mode, this layer is called only AFTER user approval.
- All env vars (`TOSS_APP_KEY`, `TOSS_SECRET_KEY`, `TOSS_ACCOUNT_NO`) must be validated before making requests.
- 10-second timeout on all requests.
- Order input validation: symbol must be non-empty string, quantity must be positive integer.

## Testing

Fully tested with mocked `fetch`.
