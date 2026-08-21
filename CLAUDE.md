# siglens-trader — CLAUDE.md

## Overview

US equity auto-trading system. Generates trading signals from AI analysis (via siglens-core) and executes orders based on configured mode.
Personal use only (Toss Securities Terms — trading data for personal use only).

---

## Layer Structure

```
api/              → Web-standard (Request) => Response handlers (HTTP + cron + reconcile)
server/           → Hono app: serves the built SPA, mounts api/ handlers, runs node-cron
src/              → React SPA (Dashboard UI)
lib/strategy/     → Domain: pure logic (no external deps). Includes safe-extract helpers for NaN defense,
                    trade-plan (sizing fraction → share count) and confluence (rule-based indicator score).
lib/analysis/     → Application: siglens-core integration, incl. the AI sizing gate (trade-gate.ts)
                    and confluence.ts (FMP bars → siglens-core indicators → confluence snapshot; no LLM)
lib/trading/      → Infrastructure: Toss API I/O (idempotency keys, retry policy)
lib/data/         → Infrastructure: FMP, Yahoo Finance I/O, live price fetch
lib/notification/ → Infrastructure: Resend Email I/O
lib/auth/         → Application: login/session lifecycle (bcrypt, session cookie, login throttle)
lib/db/           → Infrastructure: Neon PostgreSQL I/O (16 tables, DB transactions, consistency checker)
lib/lock.ts       → Distributed lock (Redis SETNX + UUID owner + Lua script release)
lib/validation.ts → Shared NaN guards (isFinitePositive, safeNumber)
```

### Dependency Direction

```
api/ → lib/strategy, lib/analysis, lib/trading, lib/notification, lib/db
src/ → API calls only (NEVER import lib/ directly)
lib/strategy/ → No external deps (pure functions only). Exception: safe-extract.ts and trade-plan.ts import lib/validation.
lib/analysis/ → @y0ngha/siglens-core, lib/data, lib/strategy (types + pure helpers only — the arrow never points back)
lib/trading/ → External HTTP (Toss API)
lib/data/ → External HTTP (FMP, Yahoo), @y0ngha/siglens-core (types only). live-price.ts → FMP quote API.
lib/notification/ → External HTTP (Resend)
lib/auth/ → lib/db (Db type + schema) only. cookie.ts and throttle.ts are pure.
lib/db/ → @neondatabase/serverless, drizzle-orm. recovery.ts → DB consistency checks. seed-operator.ts (CLI only) → lib/auth.
lib/lock.ts → @upstash/redis (SETNX distributed lock)
lib/validation.ts → No external deps (pure guards)
```

### Prohibited

- `src/` must NEVER import from `lib/` — communicate via API only
- `lib/strategy/` must NEVER perform I/O — pure functions only
- Changes to `lib/trading/` interface must NOT require changes in `lib/strategy/` (decoupled)

---

## Authentication

Primary path is the app's own login: `POST /api/auth/login` verifies the password
(bcrypt cost 12) against `users`, opens a `sessions` row, and returns it as the
`trader_session` HttpOnly cookie. There is **no signup endpoint** — accounts are
provisioned with `yarn db:seed-operator` (`OPERATOR_EMAIL` / `OPERATOR_PASSWORD`).

`users` / `sessions` deliberately mirror siglens' column shapes so the two account
systems can be merged later without a schema redesign.

A Cloudflare Access JWT is still accepted (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`)
so the site keeps working while Access sits in front of the origin. There is **no
`cf-access-authenticated-user-email` header-trust fallback**: with Access off the
origin is reachable directly and a forged header would be an auth bypass.

For local development, set `DISABLE_AUTH=true` in `.env.local`. It is ignored in
production, and it never fabricates an identity — `getSessionUser()` still returns
null, only `isAuthenticated()` short-circuits.

All dashboard API endpoints (non-cron) check `isAuthenticated(req)` from `api/_lib/auth.ts`.
Cron endpoints use `CRON_SECRET` header verification via `api/_lib/cron-auth.ts`.

### Data ownership

Operator-owned tables (`watchlist`, `analysis_model_config`, `positions`, `trades`,
`pending_orders`, `config`, `order_tracking`, `notification_config`) carry a `user_id`
column. `db:seed-operator` backfills existing rows and sets the column DEFAULT to the
operator, so trading and cron insert paths need no user plumbing. Reads are **not**
scoped by `user_id` — that is correct only while signup is absent and exactly one
account exists. Adding signup means dropping the DEFAULT and scoping every read.

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
7. **Circuit breakers** — Kill switch, daily trade limit, daily loss limit (realized + unrealized), per-symbol exposure cap. Only the kill switch stops everything; the two limits block **new entries** and leave liquidation running, because a risk breaker that blocks the only risk-reducing path is itself a defect.
8. **Order lifecycle** — Idempotency keys per order, order_tracking table, reconciliation cron for timeout detection
9. **DB atomicity** — Trade + position changes wrapped in DB transactions to prevent inconsistent state
10. **NaN defense** — `lib/validation.ts` guards + `lib/strategy/safe-extract.ts` for untyped AI JSON

---

## Signal Scoring

Priority-weighted average (weights sum to 35 on `1Hour`, 36 on `30Min`, 38 on `15Min` — a
weighted average, so the sum itself carries no meaning):
- Confluence: 12
- Technical: 8
- News: 6
- Options: 5
- Fundamental: 4
- Congress: **0** — 축은 돌지만 점수에 투표하지 않는다. 프로덕션 실측 31/31 `bullish`
  (분산 0)로, 투표가 아니라 상수 가산점이었다. 근거와 되돌리는 법은 `DEFAULT_WEIGHTS` 독스트링.

Buy threshold: 70, Sell threshold: 30 (configurable via dashboard).
`WEIGHTS_BY_TIMEFRAME` shifts weight toward price action on shorter timeframes (15Min raises
confluence to 14 and technical to 10 while cutting fundamental/congress); `1Hour` is the default
profile above. Stored `score_weights` overrides the profile key by key.

### Indicator Confluence

The only axis that never calls an LLM, and the heaviest one. The rule is siglens' backtest
winner (2024.04–2026.04, 100 cases): **3+ distinct bullish signal types active at once, at least
one of them newly lit versus the previous bar, and close > SMA(50)**. Its 70% win rate beat the
LLM's 61.5% over the same window, which is what the weight of 12 is paying for. Inverted
(bearish 3종 + close < MA50) it is also an exit trigger — see `evaluateExistingPosition` step 3.5.

- **Conditional vote, like congress.** No snapshot (FMP down, fewer than 121 bars, or a last bar
  older than 3× the timeframe) → weight 0, dropped from the denominator. An FMP outage leaves
  **sells and holds** behaving exactly as they did before this axis existed; new entries are
  blocked (see the abstention bullet below), which is the intended asymmetry, not a regression.
- **A trigger alone cannot buy.** Trigger (92) with every other axis neutral scores
  `(92×12 + 50×23)/35 = 64` — hold. It takes the rest at a mild 60 to reach 70.
- **The entry bar rises on purpose.** A neutral confluence pulls a former 72 down to
  `(72×23 + 50×12)/35 = 64`, below the buy threshold, so fill count drops. That is the point —
  *no entry the indicators do not back* — not a regression to tune away.
- **Confluence abstention blocks a buy too.** A `null` snapshot drops the axis's weight, which
  is *looser*, not neutral: with the other five fixed, the same symbol scores 64 (hold) at a
  genuinely neutral confluence and **72 (buy)** when FMP simply failed to serve bars (실측 3건이
  그 반대편을 증명했다 — 컨플루언스가 **혼자** 만든 매수 3건은 전건 손실이었다). An axis
  added to stop entries the indicators don't back was opening the gate exactly when the
  indicators were unreadable. So a `buy` verdict is downgraded to `hold` when the snapshot is
  absent; sells are untouched. The downgrade is scoped to a **live** axis: with
  `score_weights.confluence = 0` the axis does not vote at all, so a missing snapshot changes
  nothing — otherwise the documented off-switch would not actually switch it off.
- **Confluence can block a buy but never a sell.** Adding an axis widens the denominator, which
  raises *both* thresholds — intended for entries, backwards for exits. `scoreSignals` therefore
  re-scores without confluence and keeps `sell` if that verdict was `sell`. Confluence may still
  *create* a sell (its exit trigger dragging the score down); it just cannot cancel one.
- **Turning it off** is `POST /api/config` with `score_weights.confluence = 0`. There is no
  weight-editing UI — `src/` exposes thresholds and risk settings, not `score_weights`, so the
  API call is the only path. No redeploy, no separate flag: the weight knob already existed.
- **Stored `score_weights` overrides the timeframe profile key by key**, so a row carrying all
  six keys pins the weights regardless of `analysis_timeframe`. `db:seed` therefore does **not**
  seed that row — a seeded default is indistinguishable from an operator's explicit choice and
  silently cancelled `WEIGHTS_BY_TIMEFRAME`. An existing deployment that never edited weights
  should `DELETE FROM config WHERE key = 'score_weights'` to get the profile back.

Design: [`docs/specs/2026-08-14-indicator-confluence-signal-design.md`](docs/specs/2026-08-14-indicator-confluence-signal-design.md).

---

## AI Sizing Gate

The score above decides **whether** to buy or sell. It does not decide **how much** — that is a
separate LLM call (`lib/analysis/trade-gate.ts`) made only on a path that is already going to
place an order. It returns a `fraction` (0~1) that `lib/strategy/trade-plan.ts` turns into a
share count: for an entry, a share of the executable budget (per-symbol cap ∩ total-exposure cap
∩ cash); for an exit, a share of the held quantity.

That split is the point. A 0-100 scalar throws away everything siglens-core produced —
support/resistance, target prices, risk level, entry recommendation, per-axis sentiment — and the
account state (cash, existing exposure, day's P&L headroom) never entered the number at all. The
gate reads all of it and answers one question.

- **Model**: `analysis_model_config['trade_gate']`, selected in 설정 > 분석 설정 like any analysis
  axis. No schema migration — it is just another `analysis_type` row, defaulting to enabled.
- **Entry fails closed, exit fails open.** A missed buy is a lost opportunity; a missed sell is a
  realized loss. LLM error on entry → no order + email. LLM error on exit → full liquidation.
- **`PositionEvaluation.hard`** (fixed stop-loss, corrupt price data) bypasses the gate entirely.
  Risk controls are absolute; profit targets are not.
- **Turning the gate OFF** restores `fraction = 1` — AI sizing off, no redeploy. It does *not*
  restore the pre-gate code path: `planEntry`'s cash clamp applies unconditionally.
- **Split entries multiply fill count** (one 20-share target can take ~9 fills). Review
  `max_trades_per_day` before switching to `auto`. `entry_cooldown_min` (기본 60분) is what
  actually bounds how many tranches one symbol can take per day.

Design + audit trail: [`docs/specs/2026-08-12-ai-trade-gate-design.md`](docs/specs/2026-08-12-ai-trade-gate-design.md).

---

## Cron Schedule (요약)

Cron은 node-cron으로 **인프로세스** 실행되고 스케줄은 UTC다 (`server/app.ts`의 `CRON_JOBS`).
정규장 밖 발사는 `isEtRegularSessionOpen` 런타임 게이트가 `market_closed`로 조기 반환한다.
분석 cron은 심볼을 **병렬로** 돌리고, cadence는 경과 시간이 아니라 **시계 창**으로 강제한다.

- 스케줄 표, cadence 창, reasoning 정책 → [`server/CLAUDE.md`](server/CLAUDE.md)
- 매매 실행 주기(`execute_interval_min`, 기본 10분), 진입 품질 가드, 진입 시간 창(기본 ET
  11:00–15:00), quiet hours(00:00–09:59 KST) → [`api/CLAUDE.md`](api/CLAUDE.md)

**진입만 막고 청산은 절대 막지 않는다** — 진입 시간 창도, 일일 손실/거래 한도도 마찬가지다
(원칙 7). 이 규칙은 어느 디렉터리에서 작업하든 유효하므로 여기 남긴다.

---

## Commands

전체 목록은 `package.json`의 `scripts`. 이름만으로는 알 수 없는 것들:

```bash
yarn dev              # Vite dev server — 포트 6270
yarn dev:mock         # MSW 목킹으로 백엔드 없이 UI 개발
yarn start            # tsx server/index.ts — Hono 서버 + cron. 컨테이너가 실제로 돌리는 것
yarn db:seed-operator # 운영자 계정 생성 (OPERATOR_EMAIL / OPERATOR_PASSWORD). 가입 엔드포인트가 없으므로 유일한 계정 생성 경로
yarn db:clear         # 전체 삭제 (확인 프롬프트 있음)
yarn release --ci     # 릴리스 = 배포 트리거. v* 태그 푸시가 .github/workflows/deploy.yml을 돌린다
```

---

## skills/

A **synced copy** of `siglens/skills/` — do not author or edit skill files here. They are
written and digest-maintained in the siglens repo (`yarn skills:digest-update` /
`validate:skills` live there); this repo only ships them so the analysis prompt can load
them at runtime. To pull updates: `rsync -a --delete ../siglens/skills/ ./skills/`.

Skills whose `PROMPT_DIGEST` block is missing fail to load (siglens-core ≥0.42), and the
analysis silently falls back to a degraded prompt — so a stale copy here is a quality
regression, not a crash.

---

## Deployment

Runs on a single EC2 instance behind a Cloudflare Tunnel (no ALB, no inbound ports).
Pushing a `v*` tag triggers `.github/workflows/deploy.yml`: test-gate → arm64 image → ECR →
`infra/aws/deploy.sh` (SSM pull + restart + on-box health check).

- Secrets live only in SSM `/siglens-trader/*`; the container re-reads them on every start.
- Runbook: [`infra/aws/README.md`](infra/aws/README.md). Setup + cutover: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
- Design rationale: [`docs/specs/2026-07-19-vercel-to-aws-migration-design.md`](docs/specs/2026-07-19-vercel-to-aws-migration-design.md).
