# lib/trading/ — Infrastructure (Toss Securities API)

HTTP client for order execution and balance queries via Toss Securities Open API.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `TossOrderRequest`, `TossOrderResponse`, `TossBalance` |
| `toss-client.ts` | Core HTTP client: `submitOrder()`, `getBalances()` |
| `order.ts` | Convenience wrappers: `executeBuyOrder()`, `executeSellOrder()` |

## Current Status

**Placeholder.** The Toss Securities Open API is not yet available. The interfaces and endpoint structure are provisional and will be updated when the API documentation is released.

## Rules

- This layer is ONLY called when `trading_mode === 'auto'`.
- In `dry_run` mode, this layer is completely bypassed.
- In `semi_auto` mode, this layer is called only AFTER user approval.
- All env vars (`TOSS_APP_KEY`, `TOSS_SECRET_KEY`, `TOSS_ACCOUNT_NO`) must be validated before making requests.
- 10-second timeout on all requests.

## Testing

Fully tested with mocked `fetch`. 100% coverage.
