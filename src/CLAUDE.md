# src/ — React SPA (Dashboard)

Mobile-first PWA dashboard for monitoring and controlling the auto-trading system.

## Structure

```
src/
├── main.tsx           # Entry point (QueryClient, ErrorBoundary)
├── App.tsx            # Router shell with lazy-loaded pages
├── index.css          # Tailwind + body styles + PWA safe area
├── pages/             # Route components
│   ├── Status.tsx     # System status overview
│   ├── Positions.tsx  # Open positions list
│   ├── Trades.tsx     # Trade history with reasons
│   ├── Analysis.tsx   # Latest analysis results per symbol
│   ├── Pending.tsx    # Order approval queue (approve/reject)
│   └── Settings.tsx   # Configuration (mode, watchlist, models, risk, notifications)
├── components/        # Shared UI primitives
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── EmptyState.tsx
│   ├── ErrorFallback.tsx
│   ├── ErrorMessage.tsx
│   └── LoadingSkeleton.tsx
└── lib/
    └── api.ts         # Typed fetch wrapper for all API routes
```

## Rules

- **NEVER import from `lib/` (server code).** All data flows through `/api/*` endpoints.
- All pages are lazy-loaded (`React.lazy`) for code-splitting.
- TanStack Query for all server state. 10s refetch interval, 5s staleTime.
- Dark theme: bg #0a0a0a, surface #141414, border #262626, text #fafafa.
- Mobile-first: `min-h-dvh`, safe area padding, 44px touch targets.

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

## Design

- Minimal, dark, no unnecessary chrome
- Green (#22c55e) for profit/buy, Red (#ef4444) for loss/sell
- Cards with subtle borders, clean typography
- Accessible: semantic HTML, aria-labels, focus-visible

## Testing

Pages tested with @testing-library/react + userEvent. Mock API at module level.
Test loading states, data display, empty states, error states, and user interactions.
