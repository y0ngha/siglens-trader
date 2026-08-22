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
lib/strategy/ → No external deps (pure functions only). Exceptions: safe-extract.ts and trade-plan.ts
                import lib/validation; confluence.ts re-exports @y0ngha/siglens-core (그쪽 `domain/`이
                "zero I/O, zero side effects"를 헌장으로 갖는 같은 성격의 순수 계층이라 규칙의 목적에
                어긋나지 않는다 — 비순수한 부분은 lib/analysis/ 쪽에 남겼다).
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
7. **진입만 조인다** — 킬 스위치, 일일 거래·손실 한도, 종목별 노출 상한. 전부 멈추는 것은
   킬 스위치뿐이고, 두 한도는 **신규 진입만** 막고 청산은 그대로 돌린다. 리스크를 줄이는
   유일한 경로를 막는 리스크 차단기는 그 자체가 결함이기 때문이다.

   **이 원칙은 차단기에만 적용되지 않는다.** 진입을 어렵게 만드는 **어떤 변경도** —
   게이트든, 임계 상수든, 집계 방식이든 — 청산을 같이 어렵게 만들어서는 안 된다.
   실제로 그렇게 샜다: 컨플루언스의 상위 시간축·거래량 게이트는 의도대로 진입 전용이었는데
   두 트리거가 **같은 임계 상수**를 공유하는 바람에, 진입 문턱을 올리자 청산 신호가 실측
   5건 → 1건으로 함께 줄었다. 게이트만 보고 상수를 놓친 것이다. 조이는 변경은 어느 쪽에
   떨어지는지 **명시적으로 선언**해야 하고, 양쪽에 걸린다면 문턱을 분리해야 한다
   (`CONFLUENCE_MIN` / `CONFLUENCE_EXIT_MIN`).

8. **Order lifecycle** — Idempotency keys per order, order_tracking table, reconciliation cron for timeout detection
9. **DB atomicity** — Trade + position changes wrapped in DB transactions to prevent inconsistent state
10. **NaN defense** — `lib/validation.ts` guards + `lib/strategy/safe-extract.ts` for untyped AI JSON
11. **관측 가능성도 안전 요건이다** — "조일수록 안전"은 리스크 차원에서만 참이다. 신호가
    0에 수렴하면 시스템은 안전한 게 아니라 **꺼진 것**이고, 특히 `dry_run`에서는 데이터를
    만들지 못해 개선 자체가 불가능해진다. 감사 테이블(`trade_audit`)과 스냅샷 `params`는
    전후 비교를 위해 있는데, 파라미터를 "후"가 존재하지 않게 잡으면 그 장치가 무의미해진다.

    실패 형태는 늘 같다 — **각각 정당한 조임 여러 개의 곱이 검토되지 않는 것.** 계열
    집계·`expected` 반표·폭 축소·게이트 둘을 한꺼번에 켠 결과가 진입 트리거 12 → 2였고,
    그 숫자는 아무도 의도하지 않았다. 조임을 추가할 때는 **결합 효과를 실측**하고, 신호율이
    관측 가능한 수준으로 남는지 확인한다.

12. **임계값은 분포의 꼬리에 맞춘다** — 종합 점수는 6축의 가중평균이라 개별 축의 극단이
    상쇄돼 중앙으로 모인다. "축 하나가 70이면 매수" 같은 직관에서 온 숫자는 그 분포와
    맞지 않는다. 실측에서 매수 임계 70은 p99 위(신호 0.8%), 매도 임계 30은 분포 최소값
    아래(신호 **0%**)였다 — 매도 경로가 구조적으로 죽어 있었다. 지금 값(65/40)은 상·하위
    3.4% 꼬리다. **축 산식이나 가중치를 바꾸면 분포가 움직이므로 임계값도 같이 재측정한다.**


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

Buy threshold: **65**, Sell threshold: **40** (configurable via dashboard). 두 값은 축 하나의
크기가 아니라 **종합 점수 분포의 상·하위 3.4% 꼬리**를 가리킨다 — 근거는 원칙 12.
`WEIGHTS_BY_TIMEFRAME` shifts weight toward price action on shorter timeframes (15Min raises
confluence to 14 and technical to 10 while cutting fundamental/congress); `1Hour` is the default
profile above. Stored `score_weights` overrides the profile key by key.

### Indicator Confluence

여섯 축 중 **유일하게 LLM을 거치지 않는** 축이자 가장 무거운 축(가중치 12, 30Min 프로파일 13).
룰과 채점은 **siglens-core가 소유한다** (`evaluateConfluence` / `scoreConfluence`) — 같은 룰이
siglens 백테스트와 trader에 따로 구현돼 조용히 갈라지던 것을 한 곳으로 모았다. trader는 봉을
구해 넘길 뿐이다(`lib/analysis/confluence.ts`).

**원형 룰**은 siglens 백테스트 우승안이었다: 강세 시그널 3종 동시 활성 + 그중 1종 신규 +
종가 > SMA(50). 승률 70%로 같은 구간 LLM(61.5%)을 이겼다. **다만 그 측정은 일봉·10일
보유였고 여기서는 30분봉·장중 보유로 돌린다** — 같은 상수가 같은 뜻이 아니라서 룰을
그에 맞게 고쳤고, **수정본은 백테스트로 검증된 적이 없다.** 게이트 프롬프트도 그렇게 적는다.

수정 내역과 이유:

- **타입이 아니라 지표 계열을 센다.** core의 36종은 지표 14개에서 파생된다(RSI 4, MACD 4,
  볼린저 6). 타입을 세면 같은 종가 시계열의 변형을 독립 투표로 취급한다 — 실측에서 "3종"에
  도달한 스냅샷의 16%가 지표 2개뿐이었다. 타입 수 ≥ 계열 수이므로 조이는 방향으로만 작동한다.
- **`expected` phase는 반표.** `support_proximity_bullish`는 "지지선 근처"라는 상태이지 사건이
  아니다. 확정 교차와 같은 무게를 줄 근거가 없다.
- **연속 점수 폭 15** (35..65). 트리거 스냅(92/8)만 백테스트가 뒷받침하고 연속 구간은 아니다.
  폭 30에서는 지표 하나 크로스로 65점이 나와 종합 +5.4점 — 중립에서 임계까지 거리의 27%를
  오실레이터 하나가 먹었다.
- **상위 시간축 정렬**(기본 일봉)과 **거래량 확인**(CMF/MFI)이 진입 트리거에 추가로 붙는다.
  같은 30분봉의 MA50은 3.8거래일 평균이라 "중기 추세 필터"가 아니다 — 그 이름은 일봉
  백테스트에서 온 것이다.

**둘 다 진입 전용이다.** 청산 트리거는 정렬도 거래량도 요구하지 않는다 — 트리거를 어렵게
만드는 조건이라 청산에 걸면 원칙 7 위반이다.

- **조건부 투표, congress와 같다.** 스냅샷 없음(FMP 장애, 봉 121개 미만, 마지막 봉이
  타임프레임 3배보다 낡음) → 가중치 0, 분모에서 제외. FMP 장애가 **매도와 보류**를 도입 전과
  똑같이 두고 신규 진입만 막는다 — 의도된 비대칭이다.
- **트리거만으로는 못 산다.** 트리거(92)에 나머지가 전부 중립 50이면 `(92×12 + 50×23)/35 = 64`
  — 보류다. 나머지가 60 언저리는 돼야 70에 닿는다.
- **컨플루언스 기권도 매수를 막는다.** `null`은 중립이 아니라 **더 느슨한** 상태라, 지표를
  읽을 수 없을 때 오히려 문이 열리는 역설이 생긴다. 그래서 스냅샷이 없으면 `buy` 판정을
  `hold`로 내린다. 매도는 건드리지 않는다.
- **매수는 막아도 매도는 못 막는다.** 축을 더하면 분모가 커져 양쪽 문턱이 대칭으로 오르는데,
  매수가 어려워지는 건 목적이고 매도가 어려워지는 건 정반대다. `scoreSignals`가 컨플루언스
  없이 재계산해 그쪽이 `sell`이면 `sell`을 유지한다.
- **끄는 법**은 `POST /api/config`로 `score_weights.confluence = 0`. UI는 없다.

**튜너블 5개는 전부 설정이다** — 기본값이 측정이 아니라 판단이므로 재배포 없이 되돌릴 수
있어야 한다. `confluence_min`(진입, 1~14) / `confluence_exit_min`(**청산, 진입과 독립**, 1~14) /
`confluence_span`(0~50) / `confluence_expected_weight`(0~1) /
`confluence_htf`(`analysis_timeframe`보다 상위여야 하며 `off` 가능) / `confluence_require_volume`. 적용값은 스냅샷의 `params`에 기록되어 설정 변경
전후를 사후 비교할 수 있다 — 이 축을 튜닝할 유일한 근거다.

> 진입·청산 문턱이 **분리돼 있는** 이유는 원칙 7 참고 — 하나로 묶여 있던 탓에 진입을
> 조이자 청산 신호가 실측 5건 → 1건으로 같이 줄었다. 하한이 1인 이유: 0이면 `>= 0` 비교가
> 항상 참이라 눌림 신호 하나에 전량 청산된다.

원형 설계: [`docs/specs/2026-08-14-indicator-confluence-signal-design.md`](docs/specs/2026-08-14-indicator-confluence-signal-design.md)
(30분봉 재설계는 그 문서를 대체한다 — 위 내용이 현행이다).

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
