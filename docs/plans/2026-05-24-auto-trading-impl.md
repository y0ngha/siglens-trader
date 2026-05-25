# Auto-Trading System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal auto-trading system that uses siglens-core AI analysis to trade US stocks via Toss Securities Open API, deployed on Vercel with a React SPA dashboard.

**Architecture:** Vercel Serverless Functions handle cron-triggered analysis + trade execution. React SPA (Vite) serves as monitoring dashboard. Neon PostgreSQL stores state/history. siglens-core provides analysis via shared Upstash Redis job queue with siglens-worker.

**Tech Stack:** Vite + React 19, Vercel Serverless Functions, Neon PostgreSQL + Drizzle ORM, Upstash Redis (shared), TanStack Query, Tailwind CSS v4, Resend (email), Cloudflare Access

**Spec:** `docs/specs/2026-05-24-auto-trading-design.md`

---

## Phase 1: Project Restructure + Infrastructure

The current scaffolding uses a monorepo (daemon/dashboard/shared) that doesn't match the spec. We need to flatten to a single Vercel-compatible project with `api/`, `src/`, and `lib/` directories.

### Task 1: Restructure project to flat Vercel layout

**Files:**
- Delete: `daemon/`, `shared/`, `dashboard/` (entire directories)
- Create: `src/main.tsx`, `src/App.tsx`, `src/index.css`
- Create: `api/.gitkeep` (placeholder)
- Create: `lib/.gitkeep` (placeholder)
- Modify: `package.json` (remove workspaces, update deps)
- Create: `tsconfig.json` (single flat config)
- Modify: `vite.config.ts` (move from dashboard/)
- Create: `index.html` (move from dashboard/)
- Create: `vercel.json`
- Create: `.env.example`
- Create: `public/robots.txt`

- [ ] **Step 1: Remove old scaffolding**

```bash
cd /Users/y0ngha/Project/siglens-trader
rm -rf daemon shared dashboard
```

- [ ] **Step 2: Create new package.json**

```json
{
    "name": "siglens-trader",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "author": "신용하 <dev.y0ngha@gmail.com>",
    "license": "PolyForm-Noncommercial-1.0.0",
    "scripts": {
        "dev": "vite",
        "build": "tsc -b && vite build",
        "preview": "vite preview",
        "typecheck": "tsc --noEmit",
        "lint": "eslint",
        "lint:fix": "eslint --fix",
        "lint:style": "stylelint --allow-empty-input '**/*.{css,scss}'",
        "lint:style-fix": "stylelint --fix '**/*.{css,scss}'",
        "test": "vitest run",
        "test:watch": "vitest",
        "format": "prettier --write .",
        "format:check": "prettier --check .",
        "db:generate": "drizzle-kit generate",
        "db:migrate": "tsx lib/db/migrate.ts",
        "prepare": "husky"
    },
    "dependencies": {
        "@neondatabase/serverless": "^1.1.0",
        "@tanstack/react-query": "^5.95.2",
        "@upstash/redis": "^1.37.0",
        "@vercel/functions": "^3.4.3",
        "@y0ngha/siglens-core": "0.12.0",
        "clsx": "^2.1.1",
        "drizzle-orm": "^0.45.2",
        "react": "^19.2.4",
        "react-dom": "^19.2.4",
        "react-error-boundary": "^6.1.1",
        "react-markdown": "^10.1.0",
        "react-router": "^7.6.2",
        "resend": "^6.12.2",
        "tailwind-merge": "^3.5.0",
        "yahoo-finance2": "3.14.1"
    },
    "devDependencies": {
        "@eslint/js": "^9.28.0",
        "@tailwindcss/vite": "^4",
        "@testing-library/dom": "^10.4.1",
        "@testing-library/jest-dom": "^6.9.1",
        "@testing-library/react": "^16.3.2",
        "@testing-library/user-event": "^14.6.1",
        "@types/react": "^19",
        "@types/react-dom": "^19",
        "@vitejs/plugin-react": "^4.5.2",
        "drizzle-kit": "^0.31.10",
        "eslint": "^9",
        "eslint-plugin-react-hooks": "^5.2.0",
        "eslint-plugin-react-refresh": "^0.4.20",
        "globals": "^16.2.0",
        "husky": "^9.1.7",
        "jsdom": "^26.1.0",
        "prettier": "^3.7.4",
        "prettier-plugin-tailwindcss": "^0.7.2",
        "stylelint": "^17.0.0",
        "stylelint-config-recess-order": "^7.4.0",
        "stylelint-config-standard": "^40.0.0",
        "stylelint-order": "^7.0.0",
        "tailwindcss": "^4",
        "tsx": "^4.19.4",
        "typescript": "^5",
        "typescript-eslint": "^8.33.1",
        "vite": "^6.3.5",
        "vite-plugin-pwa": "^1.0.0",
        "vitest": "^3.2.1"
    },
    "packageManager": "yarn@4.12.0"
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "jsx": "react-jsx",
        "noEmit": true,
        "isolatedModules": true,
        "resolveJsonModule": true,
        "allowImportingTsExtensions": true,
        "paths": {
            "@/*": ["./src/*"],
            "@lib/*": ["./lib/*"]
        }
    },
    "include": ["src", "lib", "api", "vite-env.d.ts"],
    "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        VitePWA({
            registerType: 'autoUpdate',
            manifest: {
                name: 'SigLens Trader',
                short_name: 'Trader',
                description: 'Auto-trading dashboard',
                theme_color: '#0a0a0a',
                background_color: '#0a0a0a',
                display: 'standalone',
                icons: [
                    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                ],
            },
        }),
    ],
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
            '@lib': resolve(__dirname, 'lib'),
        },
    },
    server: {
        port: 6270,
    },
});
```

- [ ] **Step 5: Create vercel.json**

```json
{
    "buildCommand": "vite build",
    "outputDirectory": "dist",
    "framework": "vite",
    "functions": {
        "api/**/*.ts": {
            "maxDuration": 800
        }
    },
    "crons": [
        { "path": "/api/cron/technical", "schedule": "*/15 22-23,0-5 * * 1-5" },
        { "path": "/api/cron/news", "schedule": "*/15 22-23,0-5 * * 1-5" },
        { "path": "/api/cron/options", "schedule": "*/15 22-23,0-5 * * 1-5" },
        { "path": "/api/cron/fundamental", "schedule": "0 22 * * 1-5" },
        { "path": "/api/cron/execute", "schedule": "7,22,37,52 22-23,0-5 * * 1-5" }
    ],
    "rewrites": [
        { "source": "/((?!api/).*)", "destination": "/index.html" }
    ],
    "headers": [
        {
            "source": "/(.*)",
            "headers": [{ "key": "X-Robots-Tag", "value": "noindex, nofollow" }]
        }
    ]
}
```

- [ ] **Step 6: Create index.html**

```html
<!doctype html>
<html lang="ko">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <title>SigLens Trader</title>
    </head>
    <body>
        <div id="root"></div>
        <script type="module" src="/src/main.tsx"></script>
    </body>
</html>
```

- [ ] **Step 7: Create .env.example**

```env
# Vercel Cron
CRON_SECRET=

# siglens-core infra (shared instance)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
WORKER_URL=
WORKER_SECRET=

# Data sources
FMP_API_KEY=
MARKET_DATA_PROVIDER=fmp

# BYOK — LLM premium models (activated per analysis type in dashboard)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=

# Toss Securities Open API
TOSS_APP_KEY=
TOSS_SECRET_KEY=
TOSS_ACCOUNT_NO=

# DB
DATABASE_URL=

# Notifications
RESEND_API_KEY=
NOTIFICATION_EMAIL_FROM=noreply@siglens.io
```

- [ ] **Step 8: Create public/robots.txt**

```
User-agent: *
Disallow: /
```

- [ ] **Step 9: Create vite-env.d.ts**

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 10: Install dependencies**

```bash
yarn install
```

- [ ] **Step 11: Verify build works**

Create minimal `src/main.tsx`:
```typescript
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<div>SigLens Trader</div>);
```

Create minimal `src/index.css`:
```css
@import 'tailwindcss';
```

Run: `yarn typecheck && yarn build`

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: restructure to flat Vercel project layout"
```

---

### Task 2: Database schema with Drizzle ORM

**Files:**
- Create: `lib/db/schema.ts`
- Create: `lib/db/index.ts`
- Create: `lib/db/migrate.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: Create lib/db/schema.ts**

```typescript
import {
    pgTable,
    serial,
    text,
    boolean,
    integer,
    numeric,
    jsonb,
    timestamp,
} from 'drizzle-orm/pg-core';

export const watchlist = pgTable('watchlist', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull().unique(),
    companyName: text('company_name').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisModelConfig = pgTable('analysis_model_config', {
    id: serial('id').primaryKey(),
    analysisType: text('analysis_type').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    modelId: text('model_id').notNull(),
    useByok: boolean('use_byok').default(false).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisResults = pgTable('analysis_results', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    analysisType: text('analysis_type').notNull(),
    result: jsonb('result').notNull(),
    modelId: text('model_id').notNull(),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }).notNull(),
    cronRunId: text('cron_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const positions = pgTable('positions', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: integer('quantity').notNull(),
    avgPrice: numeric('avg_price').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closePrice: numeric('close_price'),
    status: text('status').default('open').notNull(),
});

export const trades = pgTable('trades', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    quantity: integer('quantity').notNull(),
    price: numeric('price').notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    mode: text('mode').notNull(),
    cronRunId: text('cron_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const pendingOrders = pgTable('pending_orders', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: integer('quantity').notNull(),
    priceLimit: numeric('price_limit'),
    analysisSummary: text('analysis_summary'),
    signalScore: numeric('signal_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status').default('pending').notNull(),
});

export const config = pgTable('config', {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const notificationConfig = pgTable('notification_config', {
    id: serial('id').primaryKey(),
    channel: text('channel').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    target: text('target').notNull(),
    events: text('events').array().default([]).notNull(),
});
```

- [ ] **Step 2: Create lib/db/index.ts**

```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export function createDb() {
    const sql = neon(process.env.DATABASE_URL!);
    return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
```

- [ ] **Step 3: Create lib/db/migrate.ts**

```typescript
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

async function main() {
    const sql = neon(process.env.DATABASE_URL!);
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migration complete');
}

main().catch(console.error);
```

- [ ] **Step 4: Create drizzle.config.ts**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './lib/db/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
});
```

- [ ] **Step 5: Verify typecheck passes**

Run: `yarn typecheck`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle ORM schema for all tables"
```

---

### Task 3: Cron auth utility + DB queries

**Files:**
- Create: `api/_lib/cron-auth.ts`
- Create: `api/_lib/db.ts`
- Create: `lib/db/queries.ts`

- [ ] **Step 1: Create api/_lib/cron-auth.ts**

```typescript
import type { VercelRequest } from '@vercel/functions';

export function verifyCronSecret(req: VercelRequest): boolean {
    const secret = req.headers['authorization'];
    return secret === `Bearer ${process.env.CRON_SECRET}`;
}
```

- [ ] **Step 2: Create api/_lib/db.ts**

```typescript
import { createDb } from '@lib/db';

let _db: ReturnType<typeof createDb> | null = null;

export function getDb() {
    if (!_db) _db = createDb();
    return _db;
}
```

- [ ] **Step 3: Create lib/db/queries.ts**

```typescript
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Db } from './index';
import {
    watchlist,
    analysisModelConfig,
    analysisResults,
    positions,
    trades,
    pendingOrders,
    config,
    notificationConfig,
} from './schema';

export async function getEnabledWatchlist(db: Db) {
    return db.select().from(watchlist).where(eq(watchlist.enabled, true));
}

export async function getAnalysisConfig(db: Db, type: string) {
    const rows = await db
        .select()
        .from(analysisModelConfig)
        .where(eq(analysisModelConfig.analysisType, type));
    return rows[0] ?? null;
}

export async function getConfigValue<T>(db: Db, key: string): Promise<T | null> {
    const rows = await db.select().from(config).where(eq(config.key, key));
    return (rows[0]?.value as T) ?? null;
}

export async function setConfigValue(db: Db, key: string, value: unknown) {
    await db
        .insert(config)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: config.key,
            set: { value, updatedAt: new Date() },
        });
}

export async function saveAnalysisResult(
    db: Db,
    params: {
        symbol: string;
        analysisType: string;
        result: unknown;
        modelId: string;
        analyzedAt: Date;
        cronRunId?: string;
    }
) {
    await db.insert(analysisResults).values(params);
}

export async function getLatestAnalysisResult(
    db: Db,
    symbol: string,
    type: string
) {
    const rows = await db
        .select()
        .from(analysisResults)
        .where(and(eq(analysisResults.symbol, symbol), eq(analysisResults.analysisType, type)))
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(1);
    return rows[0] ?? null;
}

export async function getOpenPositions(db: Db) {
    return db.select().from(positions).where(eq(positions.status, 'open'));
}

export async function getOpenPositionBySymbol(db: Db, symbol: string) {
    const rows = await db
        .select()
        .from(positions)
        .where(and(eq(positions.symbol, symbol), eq(positions.status, 'open')));
    return rows[0] ?? null;
}

export async function insertTrade(
    db: Db,
    params: {
        symbol: string;
        side: string;
        orderType: string;
        quantity: number;
        price: number;
        executedAt: Date;
        reason?: string;
        mode: string;
        cronRunId?: string;
    }
) {
    await db.insert(trades).values({
        ...params,
        price: String(params.price),
    });
}

export async function getRecentTrades(db: Db, limit = 50) {
    return db.select().from(trades).orderBy(desc(trades.executedAt)).limit(limit);
}

export async function insertPendingOrder(
    db: Db,
    params: {
        symbol: string;
        side: string;
        quantity: number;
        priceLimit?: number;
        analysisSummary?: string;
        signalScore?: number;
        expiresAt: Date;
    }
) {
    await db.insert(pendingOrders).values({
        ...params,
        priceLimit: params.priceLimit ? String(params.priceLimit) : null,
        signalScore: params.signalScore ? String(params.signalScore) : null,
    });
}

export async function getPendingOrders(db: Db) {
    return db
        .select()
        .from(pendingOrders)
        .where(eq(pendingOrders.status, 'pending'))
        .orderBy(desc(pendingOrders.createdAt));
}

export async function approvePendingOrder(db: Db, id: number) {
    await db
        .update(pendingOrders)
        .set({ status: 'approved' })
        .where(eq(pendingOrders.id, id));
}

export async function rejectPendingOrder(db: Db, id: number) {
    await db
        .update(pendingOrders)
        .set({ status: 'rejected' })
        .where(eq(pendingOrders.id, id));
}

export async function getNotificationConfig(db: Db) {
    return db.select().from(notificationConfig);
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add cron auth, DB singleton, and query helpers"
```

---

### Task 4: Data adapters (FMP + Yahoo)

**Files:**
- Create: `lib/data/fmp-http.ts`
- Create: `lib/data/fmp-types.ts`
- Create: `lib/data/fmp-fundamental.ts`
- Create: `lib/data/fmp-news.ts`
- Create: `lib/data/yahoo-options.ts`

- [ ] **Step 1: Create lib/data/fmp-http.ts**

Copy from siglens's `infrastructure/fmp/httpClient.ts`, adapting the import:

```typescript
import { readFmpConfig } from '@y0ngha/siglens-core';

export const FMP_STABLE_BASE = 'https://financialmodelingprep.com/stable';
const FMP_FETCH_TIMEOUT_MS = 10_000;

export async function fmpGet<T>(
    path: string,
    query: Record<string, string> = {}
): Promise<T> {
    const { apiKey } = readFmpConfig();
    const params = new URLSearchParams({ ...query, apikey: apiKey });
    const res = await fetch(`${FMP_STABLE_BASE}/${path}?${params.toString()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FMP_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`FMP ${path} ${res.status}`);
    }
    return (await res.json()) as T;
}
```

- [ ] **Step 2: Create lib/data/fmp-types.ts**

Copy the full contents of siglens's `infrastructure/fmp/types.ts` (all Raw* interfaces).

- [ ] **Step 3: Create lib/data/fmp-fundamental.ts**

Copy the full `FmpFundamentalClient` class from siglens's `infrastructure/fmp/fundamentalClient.ts`, updating imports to use local `fmp-http.ts` and `fmp-types.ts`:

```typescript
import { fmpGet } from './fmp-http';
import type { RawFmpProfile, RawFmpKeyMetricsTtm, /* ... */ } from './fmp-types';
import type { FundamentalDataProvider, /* ... */ } from '@y0ngha/siglens-core';
// ... rest of file identical to siglens version
```

- [ ] **Step 4: Create lib/data/fmp-news.ts**

Copy `FmpNewsClient` from siglens's `infrastructure/fmp/newsClient.ts`, adapting imports:

```typescript
import { createHash } from 'crypto';
import type { NewsItem, NewsTimeRange } from '@y0ngha/siglens-core';
import { fmpGet } from './fmp-http';
import type { RawFmpNews } from './fmp-types';

const MS_PER_HOUR = 3_600_000;
// ... rest identical to siglens version, replacing @/domain/constants/time with inline constant
```

- [ ] **Step 5: Create lib/data/yahoo-options.ts**

Copy normalization logic from siglens's `infrastructure/options/yahooNormalize.ts` and add a fetch function:

```typescript
import type { OptionsSnapshot } from '@y0ngha/siglens-core';
import yahooFinance from 'yahoo-finance2';
import {
    normalizeYahooSnapshot,
    type YahooOptionsResult,
} from './yahoo-normalize';

export async function fetchOptionsSnapshot(
    symbol: string
): Promise<OptionsSnapshot | null> {
    try {
        const result = await yahooFinance.options(symbol);
        return normalizeYahooSnapshot(result as unknown as YahooOptionsResult, new Date());
    } catch {
        console.warn(`[yahoo-options] failed to fetch ${symbol}`);
        return null;
    }
}
```

Create `lib/data/yahoo-normalize.ts` with the full normalization code from siglens, replacing `@/domain/constants/time` with inline `const MS_PER_DAY = 86_400_000`.

- [ ] **Step 6: Verify typecheck**

Run: `yarn typecheck`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add FMP and Yahoo Finance data adapters"
```

---

### Task 5: Analysis runner + polling utility

**Files:**
- Create: `lib/analysis/poll-until-done.ts`
- Create: `lib/analysis/run-technical.ts`
- Create: `lib/analysis/run-news.ts`
- Create: `lib/analysis/run-options.ts`
- Create: `lib/analysis/run-fundamental.ts`
- Create: `lib/analysis/run-overall.ts`
- Create: `lib/analysis/types.ts`

- [ ] **Step 1: Create lib/analysis/types.ts**

```typescript
export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental' | 'overall';

export interface RunAnalysisOptions {
    symbol: string;
    companyName: string;
    modelId: string;
    userApiKey?: string;
}

export interface AnalysisRunResult {
    status: 'done' | 'cached' | 'error' | 'skipped';
    result?: unknown;
    error?: string;
}
```

- [ ] **Step 2: Create lib/analysis/poll-until-done.ts**

```typescript
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_TIME_MS = 600_000; // 10 minutes

export async function pollUntilDone<T>(
    pollFn: (jobId: string) => Promise<{ status: string; result?: T; error?: string }>,
    jobId: string
): Promise<{ result: T } | { error: string }> {
    const deadline = Date.now() + MAX_POLL_TIME_MS;

    while (Date.now() < deadline) {
        const response = await pollFn(jobId);

        if (response.status === 'done' && response.result) {
            return { result: response.result };
        }
        if (response.status === 'error') {
            return { error: response.error ?? 'Unknown error' };
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return { error: 'Poll timeout exceeded' };
}
```

- [ ] **Step 3: Create lib/analysis/run-technical.ts**

```typescript
import { submitAnalysis, pollAnalysis } from '@y0ngha/siglens-core';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

export async function runTechnicalAnalysis(
    options: RunAnalysisOptions
): Promise<AnalysisRunResult> {
    try {
        const submission = await submitAnalysis(
            options.symbol,
            options.companyName,
            '1Day',
            false,
            undefined,
            { modelId: options.modelId, userApiKey: options.userApiKey }
        );

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
```

- [ ] **Step 4: Create lib/analysis/run-news.ts**

```typescript
import { submitNewsAnalysis, pollNewsAnalysis } from '@y0ngha/siglens-core';
import { FmpNewsClient } from '@lib/data/fmp-news';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const newsClient = new FmpNewsClient();

export async function runNewsAnalysis(
    options: RunAnalysisOptions
): Promise<AnalysisRunResult> {
    try {
        const news = await newsClient.fetchNews(options.symbol, '7d');
        if (news.length === 0) return { status: 'skipped' };

        const earnings = await newsClient.fetchEarningsReport(options.symbol);
        const upcomingCalendar = earnings ? [earnings] : [];

        const submission = await submitNewsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            news,
            upcomingCalendar,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollNewsAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
```

- [ ] **Step 5: Create lib/analysis/run-options.ts**

```typescript
import { submitOptionsAnalysis, pollOptionsAnalysis } from '@y0ngha/siglens-core';
import { fetchOptionsSnapshot } from '@lib/data/yahoo-options';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

export async function runOptionsAnalysis(
    options: RunAnalysisOptions
): Promise<AnalysisRunResult> {
    try {
        const snapshot = await fetchOptionsSnapshot(options.symbol);
        if (!snapshot || snapshot.chains.length === 0) return { status: 'skipped' };

        const expirationDate = snapshot.chains[0].expirationDate;

        const submission = await submitOptionsAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            snapshot,
            expirationDate,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollOptionsAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
```

- [ ] **Step 6: Create lib/analysis/run-fundamental.ts**

```typescript
import { submitFundamentalAnalysis, pollFundamentalAnalysis } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '@lib/data/fmp-fundamental';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const fundamentalClient = new FmpFundamentalClient();

export async function runFundamentalAnalysis(
    options: RunAnalysisOptions
): Promise<AnalysisRunResult> {
    try {
        const submission = await submitFundamentalAnalysis({
            symbol: options.symbol,
            modelId: options.modelId,
            dataProvider: fundamentalClient,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollFundamentalAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
```

- [ ] **Step 7: Create lib/analysis/run-overall.ts**

```typescript
import { submitOverallAnalysis, pollOverallAnalysis } from '@y0ngha/siglens-core';
import { FmpFundamentalClient } from '@lib/data/fmp-fundamental';
import { FmpNewsClient } from '@lib/data/fmp-news';
import { fetchOptionsSnapshot } from '@lib/data/yahoo-options';
import { pollUntilDone } from './poll-until-done';
import type { AnalysisRunResult, RunAnalysisOptions } from './types';

const fundamentalClient = new FmpFundamentalClient();
const newsClient = new FmpNewsClient();

export async function runOverallAnalysis(
    options: RunAnalysisOptions
): Promise<AnalysisRunResult> {
    try {
        const [news, snapshot] = await Promise.all([
            newsClient.fetchNews(options.symbol, '7d'),
            fetchOptionsSnapshot(options.symbol),
        ]);

        const earnings = await newsClient.fetchEarningsReport(options.symbol);
        const upcomingCalendar = earnings ? [earnings] : [];

        const submission = await submitOverallAnalysis({
            symbol: options.symbol,
            timeframe: '1Day',
            modelId: options.modelId,
            enrichedNews: news,
            upcomingCalendar,
            fundamentalProvider: fundamentalClient,
            optionsSnapshot: snapshot ?? undefined,
            userApiKey: options.userApiKey,
        });

        if (submission.status === 'cached') {
            return { status: 'cached', result: submission.result };
        }
        if (submission.status === 'pending_dependencies') {
            // Dependencies submitted — poll overall job
            const polled = await pollUntilDone(pollOverallAnalysis, submission.jobId!);
            if ('error' in polled) return { status: 'error', error: polled.error };
            return { status: 'done', result: polled.result };
        }
        if (submission.status !== 'submitted' || !submission.jobId) {
            return { status: 'skipped' };
        }

        const polled = await pollUntilDone(pollOverallAnalysis, submission.jobId);
        if ('error' in polled) return { status: 'error', error: polled.error };
        return { status: 'done', result: polled.result };
    } catch (err) {
        return { status: 'error', error: String(err) };
    }
}
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add analysis runners with polling for all 5 types"
```

---

## Phase 2: Strategy + Trading

### Task 6: Signal scorer

**Files:**
- Create: `lib/strategy/signal-scorer.ts`
- Create: `lib/strategy/types.ts`
- Test: `lib/strategy/signal-scorer.test.ts`

- [ ] **Step 1: Create lib/strategy/types.ts**

```typescript
export type TradingSignal = 'buy' | 'sell' | 'hold';

export interface SignalScore {
    total: number; // 0-100
    components: {
        technical: number;
        news: number;
        options: number;
        fundamental: number;
        overall: number;
    };
    signal: TradingSignal;
}

export interface ScoreWeights {
    technical: number;
    news: number;
    options: number;
    fundamental: number;
    overall: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
    technical: 40,
    news: 20,
    options: 20,
    fundamental: 10,
    overall: 10,
};

export const DEFAULT_BUY_THRESHOLD = 70;
export const DEFAULT_SELL_THRESHOLD = 30;
```

- [ ] **Step 2: Write failing test for signal-scorer**

Create `lib/strategy/signal-scorer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { scoreSignals } from './signal-scorer';
import { DEFAULT_WEIGHTS } from './types';

describe('scoreSignals', () => {
    it('returns buy signal when score is above buy threshold', () => {
        const result = scoreSignals(
            {
                technical: { trend: 'bullish', riskLevel: 'low' },
                news: { overallSentiment: 'bullish' },
                options: null,
                fundamental: { overallSentiment: 'bullish' },
                overall: null,
            },
            DEFAULT_WEIGHTS,
            70,
            30
        );
        expect(result.signal).toBe('buy');
        expect(result.total).toBeGreaterThanOrEqual(70);
    });

    it('returns sell signal when score is below sell threshold', () => {
        const result = scoreSignals(
            {
                technical: { trend: 'bearish', riskLevel: 'high' },
                news: { overallSentiment: 'bearish' },
                options: null,
                fundamental: { overallSentiment: 'bearish' },
                overall: null,
            },
            DEFAULT_WEIGHTS,
            70,
            30
        );
        expect(result.signal).toBe('sell');
        expect(result.total).toBeLessThanOrEqual(30);
    });

    it('returns hold when score is between thresholds', () => {
        const result = scoreSignals(
            {
                technical: { trend: 'neutral', riskLevel: 'medium' },
                news: null,
                options: null,
                fundamental: null,
                overall: null,
            },
            DEFAULT_WEIGHTS,
            70,
            30
        );
        expect(result.signal).toBe('hold');
    });

    it('handles null analyses gracefully', () => {
        const result = scoreSignals(
            { technical: null, news: null, options: null, fundamental: null, overall: null },
            DEFAULT_WEIGHTS,
            70,
            30
        );
        expect(result.total).toBe(50);
        expect(result.signal).toBe('hold');
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test lib/strategy/signal-scorer.test.ts`
Expected: FAIL with module not found

- [ ] **Step 4: Create lib/strategy/signal-scorer.ts**

```typescript
import type { SignalScore, ScoreWeights } from './types';

interface AnalysisInputs {
    technical: { trend?: string; riskLevel?: string; actionRecommendation?: unknown } | null;
    news: { overallSentiment?: string } | null;
    options: { signals?: Array<{ type?: string }> } | null;
    fundamental: { overallSentiment?: string } | null;
    overall: { integratedConclusionKo?: string; scenarios?: unknown[] } | null;
}

const SENTIMENT_SCORES: Record<string, number> = {
    bullish: 80,
    neutral: 50,
    bearish: 20,
};

const TREND_SCORES: Record<string, number> = {
    bullish: 85,
    neutral: 50,
    bearish: 15,
};

const RISK_MODIFIERS: Record<string, number> = {
    low: 10,
    medium: 0,
    high: -10,
};

function scoreTechnical(data: AnalysisInputs['technical']): number {
    if (!data) return 50;
    const trendScore = TREND_SCORES[data.trend ?? 'neutral'] ?? 50;
    const riskMod = RISK_MODIFIERS[data.riskLevel ?? 'medium'] ?? 0;
    return Math.max(0, Math.min(100, trendScore + riskMod));
}

function scoreNews(data: AnalysisInputs['news']): number {
    if (!data) return 50;
    return SENTIMENT_SCORES[data.overallSentiment ?? 'neutral'] ?? 50;
}

function scoreOptions(data: AnalysisInputs['options']): number {
    if (!data || !data.signals?.length) return 50;
    const buySignals = data.signals.filter(s => s.type === 'bullish').length;
    const sellSignals = data.signals.filter(s => s.type === 'bearish').length;
    const total = data.signals.length;
    if (total === 0) return 50;
    return Math.round(50 + ((buySignals - sellSignals) / total) * 50);
}

function scoreFundamental(data: AnalysisInputs['fundamental']): number {
    if (!data) return 50;
    return SENTIMENT_SCORES[data.overallSentiment ?? 'neutral'] ?? 50;
}

function scoreOverall(data: AnalysisInputs['overall']): number {
    if (!data) return 50;
    // Simple heuristic: if conclusion exists, use neutral; detailed parsing can be added later
    return 50;
}

export function scoreSignals(
    inputs: AnalysisInputs,
    weights: ScoreWeights,
    buyThreshold: number,
    sellThreshold: number
): SignalScore {
    const components = {
        technical: scoreTechnical(inputs.technical),
        news: scoreNews(inputs.news),
        options: scoreOptions(inputs.options),
        fundamental: scoreFundamental(inputs.fundamental),
        overall: scoreOverall(inputs.overall),
    };

    const totalWeight = weights.technical + weights.news + weights.options + weights.fundamental + weights.overall;
    const total = Math.round(
        (components.technical * weights.technical +
            components.news * weights.news +
            components.options * weights.options +
            components.fundamental * weights.fundamental +
            components.overall * weights.overall) /
            totalWeight
    );

    const signal = total >= buyThreshold ? 'buy' : total <= sellThreshold ? 'sell' : 'hold';

    return { total, components, signal };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test lib/strategy/signal-scorer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add signal scorer with weighted analysis scoring"
```

---

### Task 7: Risk manager

**Files:**
- Create: `lib/strategy/risk-manager.ts`
- Test: `lib/strategy/risk-manager.test.ts`

- [ ] **Step 1: Write failing test**

Create `lib/strategy/risk-manager.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { calculatePositionSize, shouldStopLoss, shouldTakeProfit } from './risk-manager';

describe('calculatePositionSize', () => {
    it('limits position to max size', () => {
        const size = calculatePositionSize({
            price: 150,
            maxPositionSize: 1000,
            maxTotalExposure: 5000,
            currentExposure: 0,
        });
        expect(size).toBe(6); // floor(1000 / 150)
    });

    it('reduces size when approaching max exposure', () => {
        const size = calculatePositionSize({
            price: 150,
            maxPositionSize: 1000,
            maxTotalExposure: 5000,
            currentExposure: 4500,
        });
        expect(size).toBe(3); // floor(500 / 150)
    });

    it('returns 0 when max exposure reached', () => {
        const size = calculatePositionSize({
            price: 150,
            maxPositionSize: 1000,
            maxTotalExposure: 5000,
            currentExposure: 5000,
        });
        expect(size).toBe(0);
    });
});

describe('shouldStopLoss', () => {
    it('triggers when loss exceeds threshold', () => {
        expect(shouldStopLoss(100, 96, 3)).toBe(true);
    });

    it('does not trigger within threshold', () => {
        expect(shouldStopLoss(100, 98, 3)).toBe(false);
    });
});

describe('shouldTakeProfit', () => {
    it('triggers when gain exceeds threshold', () => {
        expect(shouldTakeProfit(100, 106, 5)).toBe(true);
    });

    it('does not trigger within threshold', () => {
        expect(shouldTakeProfit(100, 103, 5)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test lib/strategy/risk-manager.test.ts`

- [ ] **Step 3: Implement risk-manager.ts**

```typescript
interface PositionSizeParams {
    price: number;
    maxPositionSize: number;
    maxTotalExposure: number;
    currentExposure: number;
}

export function calculatePositionSize(params: PositionSizeParams): number {
    const remainingExposure = Math.max(0, params.maxTotalExposure - params.currentExposure);
    const budgetByPosition = Math.min(params.maxPositionSize, remainingExposure);
    return Math.floor(budgetByPosition / params.price);
}

export function shouldStopLoss(
    avgPrice: number,
    currentPrice: number,
    stopLossPercent: number
): boolean {
    const lossPercent = ((avgPrice - currentPrice) / avgPrice) * 100;
    return lossPercent >= stopLossPercent;
}

export function shouldTakeProfit(
    avgPrice: number,
    currentPrice: number,
    takeProfitPercent: number
): boolean {
    const gainPercent = ((currentPrice - avgPrice) / avgPrice) * 100;
    return gainPercent >= takeProfitPercent;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `yarn test lib/strategy/risk-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add risk manager with position sizing and stop/take profit"
```

---

### Task 8: Trading decision module

**Files:**
- Create: `lib/strategy/decision.ts`

- [ ] **Step 1: Create lib/strategy/decision.ts**

```typescript
import type { SignalScore, TradingSignal } from './types';

export interface TradeDecision {
    action: TradingSignal;
    symbol: string;
    score: number;
    reason: string;
    quantity: number;
}

export interface DecisionContext {
    symbol: string;
    signalScore: SignalScore;
    hasOpenPosition: boolean;
    positionQuantity: number;
    calculatedSize: number;
}

export function makeTradeDecision(ctx: DecisionContext): TradeDecision {
    const { symbol, signalScore, hasOpenPosition, positionQuantity, calculatedSize } = ctx;

    if (signalScore.signal === 'buy' && !hasOpenPosition && calculatedSize > 0) {
        return {
            action: 'buy',
            symbol,
            score: signalScore.total,
            reason: `Score ${signalScore.total}/100 — BUY signal (tech:${signalScore.components.technical}, news:${signalScore.components.news})`,
            quantity: calculatedSize,
        };
    }

    if (signalScore.signal === 'sell' && hasOpenPosition) {
        return {
            action: 'sell',
            symbol,
            score: signalScore.total,
            reason: `Score ${signalScore.total}/100 — SELL signal (tech:${signalScore.components.technical}, news:${signalScore.components.news})`,
            quantity: positionQuantity,
        };
    }

    return {
        action: 'hold',
        symbol,
        score: signalScore.total,
        reason: `Score ${signalScore.total}/100 — HOLD`,
        quantity: 0,
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add trade decision module"
```

---

### Task 9: Toss Securities API client

**Files:**
- Create: `lib/trading/toss-client.ts`
- Create: `lib/trading/types.ts`
- Create: `lib/trading/order.ts`

- [ ] **Step 1: Create lib/trading/types.ts**

```typescript
export interface TossOrderRequest {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit';
    quantity: number;
    price?: number;
}

export interface TossOrderResponse {
    orderId: string;
    status: 'submitted' | 'filled' | 'rejected';
    filledPrice?: number;
    filledQuantity?: number;
    message?: string;
}

export interface TossBalance {
    symbol: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    pnl: number;
}
```

- [ ] **Step 2: Create lib/trading/toss-client.ts**

```typescript
import type { TossOrderRequest, TossOrderResponse, TossBalance } from './types';

const TOSS_BASE_URL = 'https://api.tossinvest.com';

async function tossRequest<T>(
    method: string,
    path: string,
    body?: unknown
): Promise<T> {
    const res = await fetch(`${TOSS_BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.TOSS_SECRET_KEY}`,
            'X-App-Key': process.env.TOSS_APP_KEY!,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Toss API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
}

export async function submitOrder(req: TossOrderRequest): Promise<TossOrderResponse> {
    return tossRequest<TossOrderResponse>('POST', '/v1/orders', {
        accountNo: process.env.TOSS_ACCOUNT_NO,
        symbol: req.symbol,
        side: req.side,
        orderType: req.orderType,
        quantity: req.quantity,
        price: req.price,
    });
}

export async function getBalances(): Promise<TossBalance[]> {
    return tossRequest<TossBalance[]>('GET', `/v1/accounts/${process.env.TOSS_ACCOUNT_NO}/balances`);
}
```

Note: The exact Toss API endpoints will need to be verified against their documentation. This is a placeholder structure that follows typical brokerage API patterns.

- [ ] **Step 3: Create lib/trading/order.ts**

```typescript
import { submitOrder } from './toss-client';
import type { TossOrderRequest, TossOrderResponse } from './types';

export async function executeBuyOrder(
    symbol: string,
    quantity: number
): Promise<TossOrderResponse> {
    const request: TossOrderRequest = {
        symbol,
        side: 'buy',
        orderType: 'market',
        quantity,
    };
    return submitOrder(request);
}

export async function executeSellOrder(
    symbol: string,
    quantity: number
): Promise<TossOrderResponse> {
    const request: TossOrderRequest = {
        symbol,
        side: 'sell',
        orderType: 'market',
        quantity,
    };
    return submitOrder(request);
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Toss Securities API client and order execution"
```

---

### Task 10: Email notification module

**Files:**
- Create: `lib/notification/email.ts`

- [ ] **Step 1: Create lib/notification/email.ts**

```typescript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.NOTIFICATION_EMAIL_FROM ?? 'noreply@siglens.io';
const TO = 'dev.y0ngha@gmail.com';

interface TradeNotification {
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    reason: string;
    mode: string;
}

interface ApprovalNotification {
    symbol: string;
    side: string;
    quantity: number;
    score: number;
    reason: string;
    approveUrl: string;
}

export async function sendTradeExecutedEmail(trade: TradeNotification) {
    await resend.emails.send({
        from: FROM,
        to: TO,
        subject: `[Trader] ${trade.side.toUpperCase()} ${trade.symbol} — ${trade.quantity}주`,
        html: `
            <h2>${trade.side === 'buy' ? '매수' : '매도'} 체결</h2>
            <p><strong>${trade.symbol}</strong> ${trade.quantity}주 @ $${trade.price}</p>
            <p>사유: ${trade.reason}</p>
            <p>모드: ${trade.mode}</p>
        `,
    });
}

export async function sendApprovalRequestEmail(order: ApprovalNotification) {
    await resend.emails.send({
        from: FROM,
        to: TO,
        subject: `[Trader] 승인 요청: ${order.side.toUpperCase()} ${order.symbol}`,
        html: `
            <h2>매매 승인 요청</h2>
            <p><strong>${order.symbol}</strong> ${order.side === 'buy' ? '매수' : '매도'} ${order.quantity}주</p>
            <p>신호 점수: ${order.score}/100</p>
            <p>사유: ${order.reason}</p>
            <p><a href="${order.approveUrl}">대시보드에서 확인</a></p>
        `,
    });
}

export async function sendErrorEmail(subject: string, error: string) {
    await resend.emails.send({
        from: FROM,
        to: TO,
        subject: `[Trader] 오류: ${subject}`,
        html: `<pre>${error}</pre>`,
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add email notification module via Resend"
```

---

## Phase 3: Cron Functions

### Task 11: Analysis cron functions

**Files:**
- Create: `api/cron/technical.ts`
- Create: `api/cron/news.ts`
- Create: `api/cron/options.ts`
- Create: `api/cron/fundamental.ts`

- [ ] **Step 1: Create api/cron/technical.ts**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/functions';
import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import { getEnabledWatchlist, getAnalysisConfig, saveAnalysisResult } from '@lib/db/queries';
import { runTechnicalAnalysis } from '@lib/analysis/run-technical';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (!verifyCronSecret(req)) return res.status(401).end();

    const db = getDb();
    const config = await getAnalysisConfig(db, 'technical');
    if (!config?.enabled) return res.json({ skipped: true });

    const watchlistItems = await getEnabledWatchlist(db);
    const cronRunId = `tech-${Date.now()}`;
    const results: Array<{ symbol: string; status: string }> = [];

    for (const item of watchlistItems) {
        const result = await runTechnicalAnalysis({
            symbol: item.symbol,
            companyName: item.companyName,
            modelId: config.modelId,
            userApiKey: config.useByok ? process.env.ANTHROPIC_API_KEY : undefined,
        });

        if (result.status === 'done' || result.status === 'cached') {
            await saveAnalysisResult(db, {
                symbol: item.symbol,
                analysisType: 'technical',
                result: result.result,
                modelId: config.modelId,
                analyzedAt: new Date(),
                cronRunId,
            });
        }

        results.push({ symbol: item.symbol, status: result.status });
    }

    return res.json({ cronRunId, results });
}
```

- [ ] **Step 2: Create api/cron/news.ts**

Same pattern as technical, using `runNewsAnalysis` and `'news'` type.

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/functions';
import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import { getEnabledWatchlist, getAnalysisConfig, saveAnalysisResult } from '@lib/db/queries';
import { runNewsAnalysis } from '@lib/analysis/run-news';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (!verifyCronSecret(req)) return res.status(401).end();

    const db = getDb();
    const config = await getAnalysisConfig(db, 'news');
    if (!config?.enabled) return res.json({ skipped: true });

    const watchlistItems = await getEnabledWatchlist(db);
    const cronRunId = `news-${Date.now()}`;
    const results: Array<{ symbol: string; status: string }> = [];

    for (const item of watchlistItems) {
        const result = await runNewsAnalysis({
            symbol: item.symbol,
            companyName: item.companyName,
            modelId: config.modelId,
            userApiKey: config.useByok ? process.env.GEMINI_API_KEY : undefined,
        });

        if (result.status === 'done' || result.status === 'cached') {
            await saveAnalysisResult(db, {
                symbol: item.symbol,
                analysisType: 'news',
                result: result.result,
                modelId: config.modelId,
                analyzedAt: new Date(),
                cronRunId,
            });
        }

        results.push({ symbol: item.symbol, status: result.status });
    }

    return res.json({ cronRunId, results });
}
```

- [ ] **Step 3: Create api/cron/options.ts and api/cron/fundamental.ts**

Same pattern with `runOptionsAnalysis` and `runFundamentalAnalysis` respectively.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add analysis cron functions (technical, news, options, fundamental)"
```

---

### Task 12: Execute cron function

**Files:**
- Create: `api/cron/execute.ts`

- [ ] **Step 1: Create api/cron/execute.ts**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/functions';
import { verifyCronSecret } from '../_lib/cron-auth';
import { getDb } from '../_lib/db';
import {
    getEnabledWatchlist,
    getAnalysisConfig,
    getLatestAnalysisResult,
    getConfigValue,
    getOpenPositionBySymbol,
    getOpenPositions,
    insertTrade,
    insertPendingOrder,
    saveAnalysisResult,
} from '@lib/db/queries';
import { runOverallAnalysis } from '@lib/analysis/run-overall';
import { scoreSignals } from '@lib/strategy/signal-scorer';
import { calculatePositionSize } from '@lib/strategy/risk-manager';
import { makeTradeDecision } from '@lib/strategy/decision';
import { executeBuyOrder, executeSellOrder } from '@lib/trading/order';
import { sendTradeExecutedEmail, sendApprovalRequestEmail, sendErrorEmail } from '@lib/notification/email';
import type { ScoreWeights } from '@lib/strategy/types';
import { DEFAULT_WEIGHTS, DEFAULT_BUY_THRESHOLD, DEFAULT_SELL_THRESHOLD } from '@lib/strategy/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (!verifyCronSecret(req)) return res.status(401).end();

    const db = getDb();
    const tradingMode = await getConfigValue<string>(db, 'trading_mode') ?? 'dry_run';
    const maxPositionSize = await getConfigValue<number>(db, 'max_position_size') ?? 1000;
    const maxTotalExposure = await getConfigValue<number>(db, 'max_total_exposure') ?? 5000;
    const stopLossPercent = await getConfigValue<number>(db, 'stop_loss_percent') ?? 3;
    const takeProfitPercent = await getConfigValue<number>(db, 'take_profit_percent') ?? 5;
    const weights = await getConfigValue<ScoreWeights>(db, 'score_weights') ?? DEFAULT_WEIGHTS;
    const buyThreshold = await getConfigValue<number>(db, 'buy_threshold') ?? DEFAULT_BUY_THRESHOLD;
    const sellThreshold = await getConfigValue<number>(db, 'sell_threshold') ?? DEFAULT_SELL_THRESHOLD;

    const watchlistItems = await getEnabledWatchlist(db);
    const openPositions = await getOpenPositions(db);
    const currentExposure = openPositions.reduce(
        (sum, p) => sum + Number(p.avgPrice) * p.quantity,
        0
    );

    const cronRunId = `exec-${Date.now()}`;
    const decisions: Array<{ symbol: string; action: string; score: number }> = [];

    const overallConfig = await getAnalysisConfig(db, 'overall');

    for (const item of watchlistItems) {
        try {
            // Gather latest analysis results from DB
            const [tech, news, options, fundamental] = await Promise.all([
                getLatestAnalysisResult(db, item.symbol, 'technical'),
                getLatestAnalysisResult(db, item.symbol, 'news'),
                getLatestAnalysisResult(db, item.symbol, 'options'),
                getLatestAnalysisResult(db, item.symbol, 'fundamental'),
            ]);

            // Run overall analysis (should cache-hit the sub-analyses)
            let overall = null;
            if (overallConfig?.enabled) {
                const overallResult = await runOverallAnalysis({
                    symbol: item.symbol,
                    companyName: item.companyName,
                    modelId: overallConfig.modelId,
                    userApiKey: overallConfig.useByok ? process.env.ANTHROPIC_API_KEY : undefined,
                });
                if (overallResult.status === 'done' || overallResult.status === 'cached') {
                    overall = overallResult.result;
                    await saveAnalysisResult(db, {
                        symbol: item.symbol,
                        analysisType: 'overall',
                        result: overall,
                        modelId: overallConfig.modelId,
                        analyzedAt: new Date(),
                        cronRunId,
                    });
                }
            }

            // Score signals
            const signalScore = scoreSignals(
                {
                    technical: tech?.result as any,
                    news: news?.result as any,
                    options: options?.result as any,
                    fundamental: fundamental?.result as any,
                    overall: overall as any,
                },
                weights,
                buyThreshold,
                sellThreshold
            );

            // Check existing position
            const existingPosition = await getOpenPositionBySymbol(db, item.symbol);
            const currentPrice = (tech?.result as any)?.keyLevels?.currentPrice ?? 0;

            // Calculate position size
            const calculatedSize = calculatePositionSize({
                price: currentPrice,
                maxPositionSize,
                maxTotalExposure,
                currentExposure,
            });

            // Make decision
            const decision = makeTradeDecision({
                symbol: item.symbol,
                signalScore,
                hasOpenPosition: !!existingPosition,
                positionQuantity: existingPosition?.quantity ?? 0,
                calculatedSize,
            });

            decisions.push({ symbol: item.symbol, action: decision.action, score: decision.score });

            if (decision.action === 'hold') continue;

            // Execute based on mode
            switch (tradingMode) {
                case 'dry_run':
                    await insertTrade(db, {
                        symbol: item.symbol,
                        side: decision.action,
                        orderType: 'market',
                        quantity: decision.quantity,
                        price: currentPrice,
                        executedAt: new Date(),
                        reason: decision.reason,
                        mode: 'dry_run',
                        cronRunId,
                    });
                    break;

                case 'semi_auto':
                    await insertPendingOrder(db, {
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        priceLimit: currentPrice,
                        analysisSummary: decision.reason,
                        signalScore: decision.score,
                        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min expiry
                    });
                    await sendApprovalRequestEmail({
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        score: decision.score,
                        reason: decision.reason,
                        approveUrl: `https://auto-trade.siglens.io/pending`,
                    });
                    break;

                case 'auto': {
                    const orderFn = decision.action === 'buy' ? executeBuyOrder : executeSellOrder;
                    const orderResult = await orderFn(item.symbol, decision.quantity);
                    await insertTrade(db, {
                        symbol: item.symbol,
                        side: decision.action,
                        orderType: 'market',
                        quantity: decision.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
                        executedAt: new Date(),
                        reason: decision.reason,
                        mode: 'auto',
                        cronRunId,
                    });
                    await sendTradeExecutedEmail({
                        symbol: item.symbol,
                        side: decision.action,
                        quantity: decision.quantity,
                        price: orderResult.filledPrice ?? currentPrice,
                        reason: decision.reason,
                        mode: 'auto',
                    });
                    break;
                }
            }
        } catch (err) {
            await sendErrorEmail(item.symbol, String(err));
        }
    }

    return res.json({ cronRunId, tradingMode, decisions });
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add execute cron — signal scoring, risk management, trade execution"
```

---

## Phase 4: Dashboard API Routes

### Task 13: Dashboard API routes

**Files:**
- Create: `api/status.ts`
- Create: `api/positions.ts`
- Create: `api/trades.ts`
- Create: `api/analysis.ts`
- Create: `api/config.ts`
- Create: `api/pending.ts`
- Create: `api/approve/[id].ts`

- [ ] **Step 1: Create api/status.ts**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/functions';
import { getDb } from './_lib/db';
import { getOpenPositions, getConfigValue } from '@lib/db/queries';
import { trades } from '@lib/db/schema';
import { sql, gte } from 'drizzle-orm';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
    const db = getDb();
    const openPositions = await getOpenPositions(db);
    const tradingMode = await getConfigValue<string>(db, 'trading_mode') ?? 'dry_run';

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = await db
        .select({ count: sql<number>`count(*)` })
        .from(trades)
        .where(gte(trades.executedAt, todayStart));

    return res.json({
        running: true,
        tradingMode,
        activePositions: openPositions.length,
        todayTrades: todayTrades[0]?.count ?? 0,
    });
}
```

- [ ] **Step 2: Create api/positions.ts**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/functions';
import { getDb } from './_lib/db';
import { getOpenPositions } from '@lib/db/queries';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
    const db = getDb();
    const positions = await getOpenPositions(db);
    return res.json(positions);
}
```

- [ ] **Step 3: Create remaining API routes (trades, analysis, config, pending, approve)**

Each follows the same pattern: create DB instance, query, return JSON. `config.ts` also handles POST for updates. `approve/[id].ts` handles POST to approve/reject orders.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add dashboard API routes (status, positions, trades, config, pending, approve)"
```

---

## Phase 5: React SPA Dashboard

### Task 14: Dashboard shell + routing

**Files:**
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/index.css`
- Create: `src/lib/api.ts`

- [ ] **Step 1: Create src/main.tsx**

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { refetchInterval: 10_000, retry: 1 },
    },
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary fallback={<div className="p-4 text-red-500">오류가 발생했습니다.</div>}>
            <QueryClientProvider client={queryClient}>
                <App />
            </QueryClientProvider>
        </ErrorBoundary>
    </StrictMode>,
);
```

- [ ] **Step 2: Create src/App.tsx with routing**

```typescript
import { BrowserRouter, Routes, Route, NavLink } from 'react-router';
import { StatusPage } from './pages/Status';
import { PositionsPage } from './pages/Positions';
import { TradesPage } from './pages/Trades';
import { AnalysisPage } from './pages/Analysis';
import { PendingPage } from './pages/Pending';
import { SettingsPage } from './pages/Settings';

export function App() {
    return (
        <BrowserRouter>
            <div className="flex min-h-dvh flex-col bg-[#0a0a0a] text-[#fafafa]">
                <nav className="flex gap-4 overflow-x-auto border-b border-[#262626] px-4 py-3">
                    <NavLink to="/" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">상태</NavLink>
                    <NavLink to="/positions" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">포지션</NavLink>
                    <NavLink to="/trades" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">거래내역</NavLink>
                    <NavLink to="/analysis" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">분석</NavLink>
                    <NavLink to="/pending" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">승인대기</NavLink>
                    <NavLink to="/settings" className="whitespace-nowrap text-sm opacity-70 [&.active]:opacity-100">설정</NavLink>
                </nav>
                <main className="flex-1 p-4">
                    <Routes>
                        <Route path="/" element={<StatusPage />} />
                        <Route path="/positions" element={<PositionsPage />} />
                        <Route path="/trades" element={<TradesPage />} />
                        <Route path="/analysis" element={<AnalysisPage />} />
                        <Route path="/pending" element={<PendingPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                    </Routes>
                </main>
            </div>
        </BrowserRouter>
    );
}
```

- [ ] **Step 3: Create src/lib/api.ts**

```typescript
async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, options);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json() as Promise<T>;
}

export const api = {
    getStatus: () => fetchJson<any>('/status'),
    getPositions: () => fetchJson<any[]>('/positions'),
    getTrades: () => fetchJson<any[]>('/trades'),
    getAnalysis: () => fetchJson<any[]>('/analysis'),
    getConfig: () => fetchJson<any>('/config'),
    updateConfig: (data: any) => fetchJson('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    getPending: () => fetchJson<any[]>('/pending'),
    approveOrder: (id: number) => fetchJson(`/approve/${id}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }), headers: { 'Content-Type': 'application/json' } }),
    rejectOrder: (id: number) => fetchJson(`/approve/${id}`, { method: 'POST', body: JSON.stringify({ action: 'reject' }), headers: { 'Content-Type': 'application/json' } }),
};
```

- [ ] **Step 4: Create src/index.css**

```css
@import 'tailwindcss';

body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add dashboard shell with routing and API client"
```

---

### Task 15: Dashboard pages (Status, Positions, Trades)

**Files:**
- Create: `src/pages/Status.tsx`
- Create: `src/pages/Positions.tsx`
- Create: `src/pages/Trades.tsx`

- [ ] **Step 1: Create src/pages/Status.tsx**

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function StatusPage() {
    const { data, isLoading } = useQuery({ queryKey: ['status'], queryFn: api.getStatus });

    if (isLoading) return <p className="text-neutral-400">로딩 중...</p>;
    if (!data) return null;

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">시스템 상태</h1>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card label="상태" value={data.running ? '실행 중' : '정지'} />
                <Card label="모드" value={modeLabel(data.tradingMode)} />
                <Card label="활성 포지션" value={String(data.activePositions)} />
                <Card label="오늘 거래" value={String(data.todayTrades)} />
            </div>
        </div>
    );
}

function Card({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-[#262626] bg-[#141414] p-3">
            <p className="text-xs text-neutral-400">{label}</p>
            <p className="mt-1 text-sm font-medium">{value}</p>
        </div>
    );
}

function modeLabel(mode: string) {
    switch (mode) {
        case 'dry_run': return '모의투자';
        case 'semi_auto': return '반자동';
        case 'auto': return '자동';
        default: return mode;
    }
}
```

- [ ] **Step 2: Create src/pages/Positions.tsx and src/pages/Trades.tsx**

Similar pattern — fetch data with TanStack Query, render in cards/lists.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Status, Positions, Trades dashboard pages"
```

---

### Task 16: Dashboard pages (Analysis, Pending, Settings)

**Files:**
- Create: `src/pages/Analysis.tsx`
- Create: `src/pages/Pending.tsx`
- Create: `src/pages/Settings.tsx`

- [ ] **Step 1: Create Analysis page**

Displays latest analysis results per symbol with signal scores.

- [ ] **Step 2: Create Pending page**

Lists pending orders with approve/reject buttons.

- [ ] **Step 3: Create Settings page**

Form with sections: 일반 (trading mode), 감시 종목 (watchlist CRUD), 분석 설정 (model per type), 리스크 관리 (thresholds), 알림 (email events).

- [ ] **Step 4: Verify full build**

Run: `yarn typecheck && yarn build`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Analysis, Pending, Settings dashboard pages"
```

---

## Phase 6: Final Integration

### Task 17: ESLint config + final polish

**Files:**
- Create: `eslint.config.js`
- Verify: full typecheck + lint + build passes

- [ ] **Step 1: Create eslint.config.js**

```javascript
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'drizzle', 'node_modules'] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            ecmaVersion: 2022,
            globals: { ...globals.browser, ...globals.node },
        },
        plugins: {
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
```

- [ ] **Step 2: Run full verification**

```bash
yarn typecheck
yarn lint
yarn build
yarn test
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add ESLint config and verify full build"
```

---

### Task 18: Initial git commit and DB seed script

**Files:**
- Create: `lib/db/seed.ts`

- [ ] **Step 1: Create seed script**

```typescript
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { config, analysisModelConfig, notificationConfig } from './schema';

async function seed() {
    const sql = neon(process.env.DATABASE_URL!);
    const db = drizzle(sql);

    // Default config
    const defaults = [
        { key: 'trading_mode', value: 'dry_run' },
        { key: 'max_position_size', value: 1000 },
        { key: 'max_total_exposure', value: 5000 },
        { key: 'stop_loss_percent', value: 3 },
        { key: 'take_profit_percent', value: 5 },
        { key: 'buy_threshold', value: 70 },
        { key: 'sell_threshold', value: 30 },
    ];
    for (const d of defaults) {
        await db.insert(config).values({ key: d.key, value: d.value, updatedAt: new Date() }).onConflictDoNothing();
    }

    // Default analysis model configs
    const models = [
        { analysisType: 'technical', modelId: 'claude-opus-4', enabled: true, useByok: true },
        { analysisType: 'news', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'options', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'fundamental', modelId: 'gemini-2.5-flash', enabled: true, useByok: true },
        { analysisType: 'overall', modelId: 'claude-opus-4', enabled: true, useByok: true },
    ];
    for (const m of models) {
        await db.insert(analysisModelConfig).values({ ...m, updatedAt: new Date() }).onConflictDoNothing();
    }

    // Default notification config
    await db.insert(notificationConfig).values({
        channel: 'email',
        enabled: true,
        target: 'dev.y0ngha@gmail.com',
        events: ['trade_executed', 'approval_required', 'error'],
    }).onConflictDoNothing();

    console.log('Seed complete');
}

seed().catch(console.error);
```

- [ ] **Step 2: Add script to package.json**

Add to scripts: `"db:seed": "tsx lib/db/seed.ts"`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add DB seed script with default config values"
```

---

## Summary of Deliverables

| Phase | Tasks | What's built |
|-------|-------|-------------|
| 1 | 1-5 | Project structure, DB schema, data adapters, analysis runners |
| 2 | 6-10 | Signal scoring, risk management, trading, notifications |
| 3 | 11-12 | 5 Vercel Cron functions (4 analysis + 1 execute) |
| 4 | 13 | Dashboard API routes |
| 5 | 14-16 | React SPA with 6 pages |
| 6 | 17-18 | Polish, lint, seed script |

Total: 18 tasks, ~50 commits
