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
lib/db/           → Infrastructure: Neon PostgreSQL I/O (15 tables, DB transactions, consistency checker)
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

Priority-weighted average (weights sum to 38 on the `1Hour` profile; `15Min` sums to 39 — a
weighted average, so the sum itself carries no meaning):
- Confluence: 12
- Technical: 8
- News: 6
- Options: 5
- Fundamental: 4
- Congress: 3

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

- **Conditional vote, like congress.** No snapshot (FMP down, fewer than 121 bars) → weight 0,
  dropped from the denominator. An FMP outage leaves the system behaving exactly as it did
  before this axis existed. That is the fail-safe, not an edge case.
- **A trigger alone cannot buy.** Trigger (92) with every other axis neutral scores
  `(92×12 + 50×26)/38 = 63` — hold. It takes the rest at a mild 60 to reach 70.
- **The entry bar rises on purpose.** A neutral confluence pulls a former 72 down to
  `(72×26 + 50×12)/38 = 65`, below the buy threshold, so fill count drops. That is the point —
  *no entry the indicators do not back* — not a regression to tune away.
- **Confluence abstention blocks a buy too.** A `null` snapshot drops the axis's weight, which
  is *looser*, not neutral: with the other five fixed, the same symbol scores 65 (hold) at a
  genuinely neutral confluence and **72 (buy)** when FMP simply failed to serve bars. An axis
  added to stop entries the indicators don't back was opening the gate exactly when the
  indicators were unreadable. So a `buy` verdict is downgraded to `hold` when the snapshot is
  absent; sells are untouched.
- **Confluence can block a buy but never a sell.** Adding an axis widens the denominator, which
  raises *both* thresholds — intended for entries, backwards for exits. `scoreSignals` therefore
  re-scores without confluence and keeps `sell` if that verdict was `sell`. Confluence may still
  *create* a sell (its exit trigger dragging the score down); it just cannot cancel one.
- **Turning it off** is `POST /api/config` with `score_weights.confluence = 0`. There is no
  weight-editing UI — `src/` exposes thresholds and risk settings, not `score_weights`, so the
  API call is the only path. No redeploy, no separate flag: the weight knob already existed.

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

## Cron Schedule

**Cron runs in-process via node-cron, on UTC schedules** (`server/app.ts` `CRON_JOBS`). Hours below are UTC, chosen to cover the US regular
session (13:30–21:00 UTC across EDT/EST). The runtime gate `isEtRegularSessionOpen` (America/New_York,
DST + holiday aware) tightens execution to the actual session, so out-of-session fires early-return
`market_closed`. (UTC 13:00–20:59 ≈ KST 22:00–05:59.)

Cadence is enforced by **clock windows**, not by elapsed time: `lib/analysis/cadence.ts` gives each
type a window size, and `_run-analysis-cron.ts` skips a symbol whose newest analysis already falls
in the current window. Elapsed-time checks drift, because an analysis is stamped when it is *saved*
— a 5-minute run starting at :00 is stamped :05, so the :30 tick would see only 25 minutes and skip,
silently turning a 30-minute cadence into a 45-minute one. Windows make the guard indifferent to how
long a run takes.

| Analysis type | Schedule (UTC)          | Effective spacing | Rationale |
|---------------|-------------------------|-------------------|-----------|
| technical     | `*/15 13-21 * * 1-5`    | follows timeframe | Horizon-sensitive: a new bar only closes once per timeframe tick. Surplus ticks land in a window that is already covered and collapse (1Hour config → 1 LLM call/hour despite the 15-min schedule). |
| options       | `*/15 13-21 * * 1-5`    | follows timeframe | Same as technical — option-chain snapshots are keyed by hash, so re-analysis before the next bar is pointless. |
| news          | `0 13-21 * * 1-5`       | 60 minutes        | Event-driven; major catalysts surface within ~60 min of publication. FMP news endpoint is heavily rate-limited. |
| fundamental   | `0 15 * * 1-5`          | 24 hours          | Quarterly filings and earnings do not move intraday; daily is more than sufficient. |
| congress      | `0 16 * * 1-5`          | 24 hours          | Congressional disclosures lag the actual trade by weeks; once per weekday is plenty. |
| execute       | `2-59/5 13-21 * * 1-5`  | `execute_interval_min` (기본 10분) | Cron fires every 5 min (`2-59/5` covers every minute the gate accepts, including the `:02` slot a `7-59/5` expression missed); the handler's interval gate decides whether this tick runs. `noOverlap: true` plus a 900s hard run deadline keep two runs from ever overlapping. The `:07` offset gives the top-of-hour analysis crons time to save, so a 60-min setting fires at exactly the old times. |
| reconcile     | `*/10 13-21 * * 1-5`    | 10 minutes        | Order timeout detection + DB consistency; must be more frequent than the order TTL. |
| digest        | `0 1 * * *`             | daily             | Flushes the quiet-hours notification queue at 10:00 KST. **Every day, not weekdays** — Friday-night events must reach the operator on Saturday morning. Deliberately not wrapped in the analysis-cron helper, whose US-session gate would suppress it entirely (01:00 UTC is outside the session). |

**Reasoning (상세 분석) is also per-type** — `ANALYSIS_REASONING` in `lib/analysis/types.ts`.
technical/options run with reasoning **off**: measured on deepseek-v4-flash, reasoning pushed a
single technical symbol to ~7 minutes (a 148s call truncated to zero output, then a 269s retry),
so a 4-symbol pass exceeded the 690s cron cutoff and symbols went without a signal. news,
fundamental and congress keep it on — they run hourly or daily, so the latency is affordable and
the narrative quality feeds the decision.

### 매매 실행 주기 (execute_interval_min)

가격 조건 — 진입 구간, 손절선, 익절선 — 은 전부 `execute` 틱 안에서만 판정된다. 그래서 이 간격이
곧 **반응 지연의 상한**이다. 종전 `7 13-21` 스케줄은 하루 6틱(진입 창 안은 4틱), 즉 최소 60분
간격이었고, 손절선이 뚫려도 최대 60분 방치됐다.

cron은 `7-59/5`로 5분마다 핸들러를 부르고, 실제 실행 여부는 `lib/strategy/execute-interval.ts`의
게이트가 `config.execute_interval_min`(5·10·15·20·30·60, 기본 **10**)으로 정한다. 스케줄 문자열을
설정으로 만들지 않은 이유는 node-cron 태스크가 등록 시점에 고정되기 때문 — 게이트는 대시보드에서
바꾼 즉시 다음 틱부터 먹는다. **설정 > 매매 실행 주기**.

- 허용값이 60의 약수뿐인 이유: 게이트는 `(분 − 7) mod 간격 === 0`이라, 약수가 아니면 시(hour)
  경계에서 주기가 어긋난다. 60분 설정은 종전 스케줄과 실행 시각이 분 단위로 같다.
- 게이트는 `startCronRun`보다 **앞**이다 — 건너뛴 틱까지 감사 행을 남기면 하루 78행 중 6행만
  실제 실행이라 `cron_runs`가 잡음으로 덮인다. `?force=1`은 수동 트리거용 우회.
- 설정 조회 실패는 기본값으로 **진행**한다. DB 일시 장애로 매매 틱이 사라지는 쪽이 더 나쁘다.
- 한 틱은 심볼당 FMP 호출 2회(quote + 컨플루언스 봉). 5분으로 줄이면 호출량이 두 배가 된다.

### 진입 품질 가드

실행 주기를 좁히는 것만으로는 **추격 매수**가 남는다. 분석이 "$150 진입"이라 한 뒤 가격이
$180이 돼도, 신선도 한도(1Hour 기준 2시간) 안이면 같은 분석이 그대로 쓰여 매수 신호가 살아
있기 때문이다. 손절선·목표가만 $150 기준인 포지션이 생긴다.

- **`entry_out_of_zone`** — 현재가가 `actionRecommendation.entryPrices` 최대값 + 1%를 넘으면
  매수/추가매수를 건너뛴다(`lib/strategy/entry-zone.ts`). **상단만** 본다 — 구간 아래는 매수에
  불리하지 않다. `entryPrices`가 없으면 통과(fail-open). 사이징 게이트보다 앞이라 어차피 사지
  않을 주문에 LLM 호출을 태우지 않는다. 매도에는 걸지 않는다.
- **`entry_cooldown`** — 같은 심볼 재진입 최소 간격(`config.entry_cooldown_min`, 기본 60분,
  0이면 off). 기준은 마지막 **체결**이다 — 매수뿐 아니라 **매도도 쿨다운을 건다.** 매수만 보면
  손절이 마지막 매수보다 쿨다운 뒤에 일어났을 때 손절 10분 뒤 같은 분석으로 재매수가 가능했다
  (`recentStopLossSymbols`는 실행 스코프라 다음 틱에 초기화된다). **설정 > 투자 관리**.
- **`entry_not_recommended`** — 분석의 `entryRecommendation`이 `avoid`면 점수와 무관하게 매수를
  막는다. core는 `avoid`에서도 "돌파 시 진입" **조건부** 구간을 채우므로 `entryPrices` 상단
  검사로는 걸러지지 않는다.
**노출 한도는 원가(투자 금액) 기준이다.** `max_position_size` / `max_total_exposure`는
`avgPrice × quantity`로 계산한다 — 평가액 기준이면 가격이 내릴수록 예산이 커져 한도가
아무것도 한정하지 못한다.

**물타기는 규칙으로 막지 않는다.** 점수 ≥70 + 6축 합의 + 사이징 게이트를 통과했다면 그것이
이미 AI의 추천이고, 규칙 엔진이 방향만 보고 뒤집는 것은 판단 층을 잘못 고른 것이다. 대신
게이트가 **물타기인 줄 알고** 크기를 정하도록 프롬프트에 성격을 명시한다 — 특히 모델이 계산으로
얻을 수 없는 사실 하나를 못박는다: 고정 손절선은 평단이 기준이므로 추가 매수가
손절선을 함께 내린다 (진입 지침 5번).
- **`entry_after_exit_blocked`** — 같은 틱에 부분 청산한 종목은 다시 늘리지 않는다.

청산 쪽에는 대칭 게이트를 두지 **않았다** — 가격 조건으로 매도를 막는 것은 원칙 7 위반이다.
대신 빠져 있던 트리거를 채웠다: `actionRecommendation.stopLoss` / `takeProfitPrices`(core의
`reconciledLevels` 보정값 우선)가 `evaluateExistingPosition`의 우선순위 1.5 / 4.5로 들어간다.
`fixed_exit_enabled`가 기본 꺼짐이라, 그전까지 활성 손절 경로는 지지선 이탈·추세 반전·하락
컨플루언스 같은 **간접** 신호뿐이었다.

설계 근거: [`docs/specs/2026-08-16-execution-cadence-design.md`](docs/specs/2026-08-16-execution-cadence-design.md),
감사 대응: [`docs/specs/2026-08-17-audit-fixes-design.md`](docs/specs/2026-08-17-audit-fixes-design.md).

### Entry window (신규 진입 시간 창)

신규 진입은 `config.entry_window`(기본 **ET 11:00–15:00**) 안에서만 열린다. **위 스케줄 표는
바뀌지 않는다** — 창은 스케줄이 아니라 진입 게이트다. `execute` cron은 정규장 내내 그대로 돌고,
창 밖에도 포지션 재평가·손절·청산·신호 매도는 전부 정상 동작한다. cron 창을 좁히면 마감 전
손절 경로까지 같이 죽으므로, 원칙 7에 따라 진입만 막는다.

창은 **ET에 고정**한다. 회피 대상(개장 갭, 첫 30분 변동성, 마감 MOC 임밸런스)이 전부 ET 기준
현상이라, UTC/KST에 고정하면 서머타임마다 창이 한 시간씩 밀려 목적이 반년마다 깨진다.

일일 손실/거래 한도가 쓰는 `entryBlock` 메커니즘을 그대로 재사용하되, 창은 리스크 사건이
아니므로 이메일도 `forceFullExit`도 없다. 두 사유가 동시에 성립하면 감사 로그에는 리스크 쪽이
남는다.

**설정 > 진입 시간 창**에서 조정한다. 시간 입력 두 개(ET)와 ON/OFF 토글이며, OFF가 곧
`{ start: '00:00', end: '24:00' }`(= 제한 없음)이다. 재배포도 API 직접 호출도 필요 없다.

`semi_auto` 승인은 창을 다시 보지 않는다 — 대기 주문 TTL(15분)만큼 창을 넘겨 체결될 수 있고,
운영자가 명시적으로 누른 승인을 시간으로 되돌리는 쪽이 더 혼란스러우므로 의도적으로 둔다.
또한 기본 창(ET 4시간)은 실행 주기 10분 기준 하루 39틱 중 24틱만 덮으므로, AI 사이징 게이트의
분할 진입과 겹치면 하루에 도달 가능한 포지션 크기가 줄어든다. 다만 실제 상한을 정하는 것은
`entry_cooldown_min`(기본 60분)이라 심볼당 창 안에서 4회 — 실행 주기 도입 전과 같은 숫자다.
`auto` 전환 시 `max_trades_per_day`와 함께 확인할 것.

설계 근거: [`docs/specs/2026-08-15-entry-window-design.md`](docs/specs/2026-08-15-entry-window-design.md).

### Quiet hours

No email is sent between **00:00–09:59 KST**; anything raised in that window is queued
(`notification_queue`) and delivered as one summary at 10:00 KST by the `digest` cron. The
window is expressed in the operator's local time on purpose — the point is that they are
asleep, and the US session runs through the middle of it.

The per-event gate still wins over queueing: if the channel or the event is off, nothing is
sent *or* queued, so turning email off really turns it off. If email is off when the digest
runs, queued rows are marked consumed without sending, so a disabled channel cannot grow the
queue without bound. A failed send leaves rows unsent so the next run retries — duplicate
delivery is preferable to a silently lost fill notification.

UTC `13-21` covers the US regular session across both EDT (13:30–20:00 UTC) and EST (14:30–21:00 UTC); the `isEtRegularSessionOpen` runtime gate skips out-of-session fires.

---

## Commands

```bash
yarn dev              # Vite dev server (port 6270)
yarn dev:mock         # Vite dev with MSW mocking (no backend needed)
yarn build            # tsc -b && vite build (SPA only)
yarn start            # tsx server/index.ts (Hono server + cron; what the container runs)
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
