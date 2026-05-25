# siglens-trader — CLAUDE.md

## Overview

US equity auto-trading system. Generates trading signals from AI analysis (via siglens-core) and executes orders based on configured mode.
Personal use only (Toss Securities Terms — trading data for personal use only).

---

## Layer Structure

```
api/              → Vercel Serverless Functions (HTTP handlers + cron + reconcile)
src/              → React SPA (Dashboard UI)
lib/strategy/     → Domain: pure logic (no external deps). Includes safe-extract helpers for NaN defense.
lib/analysis/     → Application: siglens-core integration
lib/trading/      → Infrastructure: Toss API I/O (idempotency keys, retry policy)
lib/data/         → Infrastructure: FMP, Yahoo Finance I/O, live price fetch
lib/notification/ → Infrastructure: Resend Email I/O
lib/db/           → Infrastructure: Neon PostgreSQL I/O (9 tables, DB transactions, consistency checker)
lib/lock.ts       → Distributed lock (Redis SETNX + UUID owner + Lua script release)
lib/validation.ts → Shared NaN guards (isFinitePositive, safeNumber)
```

### Dependency Direction

```
api/ → lib/strategy, lib/analysis, lib/trading, lib/notification, lib/db
src/ → API calls only (NEVER import lib/ directly)
lib/strategy/ → No external deps (pure functions only)
lib/analysis/ → @y0ngha/siglens-core, lib/data
lib/trading/ → External HTTP (Toss API)
lib/data/ → External HTTP (FMP, Yahoo), @y0ngha/siglens-core (types only). live-price.ts → FMP quote API.
lib/notification/ → External HTTP (Resend)
lib/db/ → @neondatabase/serverless, drizzle-orm. recovery.ts → DB consistency checks.
lib/lock.ts → @upstash/redis (SETNX distributed lock)
lib/validation.ts → No external deps (pure guards)
```

### Prohibited

- `src/` must NEVER import from `lib/` — communicate via API only
- `lib/strategy/` must NEVER perform I/O — pure functions only
- Changes to `lib/trading/` interface must NOT require changes in `lib/strategy/` (decoupled)

---

## Authentication

In production, Cloudflare Access sets `cf-access-authenticated-user-email` header.
For local development, set `DISABLE_AUTH=true` in `.env.local` to bypass authentication.

All dashboard API endpoints (non-cron) check `isAuthenticated(req)` from `api/_lib/auth.ts`.
Cron endpoints use `CRON_SECRET` header verification via `api/_lib/cron-auth.ts`.

---

## React Query Best Practice

All `useQuery` hooks must destructure `queryKey` inside `queryFn` to avoid stale closure over external state:

```typescript
useQuery({
    queryKey: ['positions', symbol],
    queryFn: async ({ queryKey: [, qSymbol], signal }) => {
        return fetchPositions(qSymbol, signal);
    },
});
```

---

## Design Principles

1. **Domain/Infra separation** — Toss API format changes don't affect strategy logic
2. **DRY_RUN first** — Full flow testable without live API
3. **Decision tracking** — Every trade stores `reason` (AI judgment basis); included in email notifications. Future: user evaluation → AI improvement loop.
4. **Configurable** — Models, weights, thresholds, watchlist all editable from dashboard
5. **Security** — Config POST uses allowlist (`ALLOWED_CONFIG_KEYS`); position close uses atomic DB update (race condition guard)
6. **MSW for dev** — `yarn dev:mock` enables Mock Service Worker for UI development without backend
7. **Circuit breakers** — Kill switch, daily trade limit, daily loss limit (realized + unrealized), per-symbol exposure cap
8. **Order lifecycle** — Idempotency keys per order, order_tracking table, reconciliation cron for timeout detection
9. **DB atomicity** — Trade + position changes wrapped in DB transactions to prevent inconsistent state
10. **NaN defense** — `lib/validation.ts` guards + `lib/strategy/safe-extract.ts` for untyped AI JSON

---

## Signal Scoring

Priority-weighted average (weights sum to 26):
- Technical: 8
- News: 6
- Options: 5
- Fundamental: 4
- Overall: 3

Buy threshold: 70, Sell threshold: 30 (configurable via dashboard).

---

## Cron Schedule

All crons run during US market hours (KST 22:00~05:59, Mon-Fri):
- Analysis crons (technical, news, options): `0 22-23,0-5 * * 1-5` (hourly)
- Fundamental: `0 22 * * 1-5` (daily at market open)
- Execute: `7 22-23,0-5 * * 1-5` (7-minute offset after analysis, hourly)
- Reconcile: `*/10 22-23,0-5 * * 1-5` (every 10 minutes — order timeout + DB consistency)

---

## Commands

```bash
yarn dev              # Vite dev server (port 4300)
yarn dev:mock         # Vite dev with MSW mocking (no backend needed)
yarn build            # tsc -b && vite build
yarn typecheck        # tsc --noEmit
yarn lint             # ESLint
yarn lint:fix         # ESLint --fix
yarn lint:style       # Stylelint
yarn lint:style-fix   # Stylelint --fix
yarn test             # Vitest (all)
yarn test:watch       # Vitest watch mode
yarn test:coverage    # Vitest with coverage
yarn format           # Prettier write
yarn format:check     # Prettier check
yarn db:generate      # Drizzle migration generate
yarn db:migrate       # Run migrations
yarn db:seed          # Insert mock data
yarn db:clear         # Delete all data (with confirmation prompt)
```
