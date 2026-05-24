# siglens-trader — CLAUDE.md

## Overview

US equity auto-trading system. Generates trading signals from AI analysis (via siglens-core) and executes orders based on configured mode.
Personal use only (Toss Securities Terms §5③ — trading data for personal use only).

---

## Layer Structure

```
api/              → Vercel Serverless Functions (HTTP handlers)
src/              → React SPA (Dashboard UI)
lib/strategy/     → Domain: pure logic (no external deps)
lib/analysis/     → Application: siglens-core integration
lib/trading/      → Infrastructure: Toss API I/O
lib/data/         → Infrastructure: FMP, Yahoo Finance I/O
lib/notification/ → Infrastructure: Resend Email I/O
lib/db/           → Infrastructure: Neon PostgreSQL I/O
```

### Dependency Direction

```
api/ → lib/strategy, lib/analysis, lib/trading, lib/notification, lib/db
src/ → API calls only (NEVER import lib/ directly)
lib/strategy/ → No external deps (pure functions only)
lib/analysis/ → @y0ngha/siglens-core, lib/data
lib/trading/ → External HTTP (Toss API)
lib/data/ → External HTTP (FMP, Yahoo), @y0ngha/siglens-core (types only)
lib/notification/ → External HTTP (Resend)
lib/db/ → @neondatabase/serverless, drizzle-orm
```

### Prohibited

- `src/` must NEVER import from `lib/` — communicate via API only
- `lib/strategy/` must NEVER perform I/O — pure functions only
- Changes to `lib/trading/` interface must NOT require changes in `lib/strategy/` (decoupled)

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

---

## Commands

```bash
yarn dev              # Vite dev server (port 4300)
yarn build            # Production build
yarn typecheck        # tsc --noEmit
yarn lint             # ESLint
yarn test             # Vitest (all)
yarn test --coverage  # Coverage report
yarn db:generate      # Drizzle migration generate
yarn db:migrate       # Run migrations
yarn db:seed          # Insert mock data
```
