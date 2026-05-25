# src/ — React SPA (Dashboard)

Mobile-first PWA dashboard for monitoring and controlling the auto-trading system.

## Structure

```
src/
├── main.tsx           # Entry point (QueryClient, ErrorBoundary)
├── App.tsx            # Router shell with lazy-loaded pages
├── index.css          # Tailwind + body styles + PWA safe area
├── pages/             # Route components
│   ├── Status.tsx     # System status + portfolio + position targets + alerts
│   ├── Positions.tsx  # Open positions list (with manual close)
│   ├── Trades.tsx     # Trade history with reasons (includes skipped trades)
│   ├── Analysis.tsx   # Latest analysis results per symbol (with trigger)
│   ├── Pending.tsx    # Order approval queue (approve/reject)
│   └── Settings.tsx   # Configuration (mode, watchlist, models, risk, notifications)
├── components/        # Shared UI primitives
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── EmptyState.tsx
│   ├── ErrorFallback.tsx
│   ├── ErrorMessage.tsx
│   ├── LoadingSkeleton.tsx
│   └── TickerSearch.tsx   # Combobox for adding watchlist symbols via FMP search
├── mocks/             # MSW (Mock Service Worker) for dev:mock mode
│   ├── browser.ts     # MSW browser setup
│   └── handlers.ts    # All API endpoint mocks with in-memory state
└── lib/
    └── api.ts         # Typed fetch wrapper for all API routes
```

## Rules

- **NEVER import from `lib/` (server code).** All data flows through `/api/*` endpoints.
- All pages are lazy-loaded (`React.lazy`) for code-splitting.
- TanStack Query for all server state. 10s refetch interval, 5s staleTime.
- Dark theme: bg #0a0a0a, surface #141414, border #262626, text #fafafa.
- Mobile-first: `min-h-dvh`, safe area padding, 44px touch targets.
- Watchlist max 5 items (enforced in Settings + server).
- Trading mode and risk settings require explicit "저장" button (not auto-save).
- Status page: portfolio overview, position targets table (buy/current/TP/SL), watchlist ON/OFF color badges, skipped trade alerts.

## React Query Pattern

Always destructure `queryKey` inside `queryFn` to avoid stale closures:

```typescript
useQuery({
    queryKey: ['trades', filter] as const,
    queryFn: async ({ queryKey: [, qFilter], signal }) => {
        return api.getTrades(qFilter, signal);
    },
});
```

Never reference external variables inside queryFn — always derive from queryKey.

## MSW Mock Mode

`yarn dev:mock` sets `VITE_API_MOCK=true`, which activates MSW in `src/mocks/browser.ts`.
The handlers in `src/mocks/handlers.ts` provide full in-memory state for all dashboard features:
- Status, positions, trades (including skipped), pending orders, analysis results
- Config CRUD (all types: config, watchlist, analysis, notification)
- Position close, order approve/reject
- Ticker search passes through to real API

## Design

- Minimal, dark, no unnecessary chrome
- Green (#22c55e) for profit/buy, Red (#ef4444) for loss/sell
- Cards with subtle borders, clean typography
- Accessible: semantic HTML, aria-labels, focus-visible, combobox pattern for search

## Testing

Pages tested with @testing-library/react + userEvent. Mock API at module level.
Test loading states, data display, empty states, error states, and user interactions.
