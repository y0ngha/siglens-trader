# lib/trading/ — Infrastructure (Toss Securities Open API)

HTTP client and order execution layer for the real Toss Securities Open API (`https://openapi.tossinvest.com`).

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Shared types: `IssueOrderRequest`, `OrderOutcome`, `OrderDetail`, `OrderSide`, `TossOrderStatus`, `TossHolding`, `OAuth2TokenResponse` |
| `token.ts` | OAuth2 `client_credentials` token lifecycle: `getAccessToken` / `forceRefreshToken`. Redis cache (`toss:oauth:token`) + distributed refresh lock (`toss:oauth:refresh`) to enforce one-token-per-client. |
| `client.ts` | Core HTTP client: `tossFetch<T>` — bearer auth, `X-Tossinvest-Account` header, response envelope unwrap (`result`), `TossApiError`, retry policy. `resolveAccountSeq` caches accountSeq from `GET /api/v1/accounts` in Redis (`toss:account:seq`). |
| `account.ts` | Account helpers: `getHoldings`, `getBuyingPower`, `getSellableQuantity`, `cancelOrder`, `isUsMarketOpen`. |
| `orders.ts` | Order execution: `issueOrder` / `getOrder` (primitives) + `executeBuyOrder` / `executeSellOrder` facades (issue + inline-poll → `OrderOutcome`). |

## Authentication

OAuth2 `client_credentials` flow via `POST /oauth2/token`:
- `TOSS_APP_KEY` = `client_id`, `TOSS_SECRET_KEY` = `client_secret`.
- Token cached in Redis at `toss:oauth:token` with TTL = `expires_in − 60s` (up to 24 h).
- Refresh protected by distributed lock `toss:oauth:refresh` (15 s TTL) — only one instance issues a new token; waiters reuse the result from cache.
- `forceRefreshToken(staleToken?)`: if `staleToken` is provided and a fresher token already exists in cache (issued by another instance), that token is reused instead of issuing a new one (stampede guard).
- Without Redis (local dev): process-local `devToken` cache prevents repeated issuance; token invalidated by `forceRefreshToken`.

## Account Resolution

`resolveAccountSeq()` in `client.ts`:
- Calls `GET /api/v1/accounts`, selects the first `BROKERAGE`-type account.
- Cached in Redis (`toss:account:seq`, 24 h TTL) and in-process (`memoSeq`).
- `account: true` option in `tossFetch` automatically appends `X-Tossinvest-Account: {accountSeq}`.
- No `TOSS_ACCOUNT_NO` env var — accountSeq is resolved dynamically.

## Async Order Model

Orders are submitted asynchronously:

1. `POST /api/v1/orders` (body: `clientOrderId`, `symbol`, `side`, `orderType`, `quantity`) → `{orderId}`.
2. Facade polls `GET /api/v1/orders/{orderId}` up to 3 × 1.5 s.
3. Returns `OrderOutcome{status: filled | partial | pending | rejected | canceled}`.
4. `filled`: execute cron books the trade immediately.
5. `pending` / `partial`: orderId preserved; reconcile cron resolves later via `getOrder`, books full fills via `autoRecover`, routes partials to `needs_review`, and cancels timed-out orders.

## clientOrderId

Toss idempotency key: passed as a **body field** (not a header), max 36 chars, `[a-zA-Z0-9\-_]`.
- `executeBuyOrder` / `executeSellOrder`: per-order random `crypto.randomUUID()` by default.
- Approve flow (`approve/[id].ts`): stable key `approve-{pendingOrderId}`.

## Retry Policy

| Condition | Behaviour |
|-----------|-----------|
| GET 5xx | Retry up to 2×, exponential backoff (1 s, 2 s) |
| POST 5xx with `clientOrderId` | Retry up to 2× (idempotent) |
| POST 5xx without `clientOrderId` | No retry |
| 429 | Retry up to 2×, respects `Retry-After` header |
| 409 `request-in-progress` | Retry up to 2×, 1 s delay |
| 409 `idempotency-key-conflict` | Thrown immediately |
| 401 | Force-refresh token (passing stale token) + retry once; does not consume retry budget |
| All requests | 10 s `AbortSignal.timeout` |

## Error Handling

Toss error envelope: `{error: {code, message, data?}}` → `TossApiError(code, message, status, data)`.

In the orders facade, business 4xx errors (e.g. insufficient funds, market closed) are caught and returned as `OrderOutcome{status: 'rejected', rejectReason: err.code}`. Transient errors (408, 429, `idempotency-key-conflict`, `request-in-progress`) are rethrown so `order_tracking` records an `error` status.

## Rules

- Only called when `trading_mode === 'auto'`.
- `dry_run` mode bypasses this layer entirely.
- `semi_auto` mode calls this layer only after user approval.
- `TOSS_APP_KEY` and `TOSS_SECRET_KEY` must be set; token issuance throws if missing.
- Order input: symbol must be a non-empty string; quantity must be a positive integer.

## Testing

Fully tested with mocked `fetch` in `__tests__/`.
