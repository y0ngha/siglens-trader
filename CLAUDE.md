# siglens-trader — CLAUDE.md

## Overview

US equity auto-trading system. Trades a **daily RSI(2) mean-reversion rule** (price-only, deterministic) and
executes orders based on the configured mode. AI analysis (via siglens-core) runs only for symbols that signal,
as a **record-only review** — it never changes an order. Design and evidence:
[`docs/specs/2026-09-24-daily-mean-reversion-design.md`](docs/specs/2026-09-24-daily-mean-reversion-design.md).
Personal use only (Toss Securities Terms — trading data for personal use only).

---

## Layer Structure

```
api/              → Web-standard (Request) => Response handlers (HTTP + cron + reconcile)
server/           → Hono app: serves the built SPA, mounts api/ handlers, runs node-cron
src/              → React SPA (Dashboard UI)
lib/strategy/     → Domain: pure logic (no external deps). mean-reversion (the trading rule), daily-loss
                    (breaker's today-change), trade-plan (budget → share count), safe-extract (NaN defense for AI JSON)
lib/analysis/     → Application: siglens-core integration — analysis runners, daily-bars.ts (FMP daily bars +
                    today's live bar), entry-review.ts (record-only AI review prompt/parse)
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
                import lib/validation.
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
3. **Decision tracking** — Every trade stores `reason` (the rule's numbers: RSI(2), SMA200, the exit that fired); every
   decision tick stores `cron_decisions.detail.mr`; the AI review of every signal lands in `trade_audit`.
4. **Configurable** — Strategy parameters, limits, models, watchlist all editable from dashboard
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
   (당시의 `CONFLUENCE_MIN` / `CONFLUENCE_EXIT_MIN` — 컨플루언스 축은 2026-09-24에 걷어냈다).

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

12. **임계값은 통과 쪽의 전진 수익률로 정한다** — (2026-09까지의 종합 점수 시절 교훈) 가중평균
    점수는 축의 극단이 상쇄돼 중앙으로 모여, 직관에서 온 임계 70은 신호 0.8%, 매도 임계 30은
    **0%**였다. 꼬리 비율로 다시 잡아도 그 구간의 전진 수익률은 기준선과 같았다 — 그 점수는
    +1일 수익률과 **역상관**이었다(스펙 §0). 지금 규칙의 임계(RSI(2) < 10)는 문헌값이고, 이웃
    값(5·15)도 같은 부호임을 백테스트로 확인했다. **임계를 바꿀 때는 분포가 아니라 그 구간의
    전진 수익률을 기준선과 나란히 본다.**


13. **게이트의 방향은 전진 수익률로 정한다** — 게이트를 넣을 때 "막았어야 할 손실을 막는가"만
    보면 **부호**를 검증하지 못한다. 상위 시간축 정렬 게이트는 손실 3건을 막는다는 사실과
    그럴듯한 추론("상위 추세에 정렬")으로 들어왔고, 한 달 뒤 처음 잰 전진 수익률은 그
    게이트가 고른 진입이 −0.54%/1일, 버린 진입이 +0.50%/1일이었다 — **가장 무거운 축의 진입
    필터가 반대 방향으로 켜져 있었다.** 트리거 개수·차단 건수는 게이트가 *작동하는지*만 말해
    주고 *옳은지*는 말해 주지 않는다. 게이트·필터·임계를 추가하거나 바꿀 때는 **통과시킨 쪽과
    버린 쪽의 전진 수익률을 기준선과 나란히** 놓고 본다(독립 표본, 심볼 제외 교차, 기간 분할).
    표본이 모자라면 그렇게 적고 옵션으로 둔다 — 추론은 가설이지 근거가 아니다.

---

## Strategy — 일봉 RSI(2) 눌림매수

`lib/strategy/mean-reversion.ts` (순수 함수, 백테스트 스크립트와 동등성 테스트로 고정).

- **진입**: 가격 > SMA200 **그리고** RSI(2) < `mr_rsi_entry`(10) **그리고** (`mr_regime_filter`면) SPY > SMA200.
  신호가 예산보다 많으면 RSI(2)가 낮은 순. 한 종목 한 포지션 — 물타기 없음.
- **청산**(전량): 가격 > SMA5 · 보유 `mr_max_hold_days`(10)거래일 · 재난 손절 `positions.stop_price`
  (= 진입가 − `mr_stop_atr`(5) × 전일까지 ATR(14)). 재난 손절만 매 틱, 나머지는 판단 틱에서.
- **판단은 하루 1회** — 장 마감 20분 전 창의 첫 execute 틱(반일장은 12:40 ET). 오늘 봉의 종가 자리에
  실시간 가격을 넣는다. 멱등 기록은 `cron_runs.summary.decisionPhase = 'done'`.
- 비중은 규칙이 정한다: 종목 한도 ∩ 총 노출 한도 ∩ 현금(`planEntry`, fraction 1).

**근거**(스펙 §2): 12년 · 성장주 16 / 부진주 22 / ETF 4 모두에서 같은 청산 규칙의 기준선 대비 우위, 승률
60~72%. 부진주는 비용 차감 후 절대 수익 ≈ 0 — 우위는 있지만 수익의 크기는 종목의 드리프트가 정한다.
동시 5포지션 포트폴리오는 약세장에서 SPY보다 낫고 강세장에서 비슷하거나 못하며, 2023-26 MDD 30%였다.
종전 1시간봉 종합 점수·컨플루언스 전략은 비용 포함 거래당 −0.25~−0.30%(구조적 손실)였고, 컨플루언스를
이 규칙의 필터·청산으로 얹는 변형 7가지도 일관된 개선이 없었다(§2.4).

**목표는 승률과 기대값을 같이 보는 것이다** — 익절을 짧게, 손절을 길게 두면 승률은 오르고 돈은 잃는다.
청산 30건이 쌓이면 승률 ≥ 60%·거래당 평균 > 0을 확인한다(§0.5).

## AI Entry Review (기록 전용)

`api/cron/review.ts` + `lib/analysis/entry-review.ts`. 판단 단계가 남긴 신호(`mr_buy`·`mr_skip_budget`·
`mr_skip_breaker`)마다 기술(1Day)·뉴스·펀더멘털 분석을 확보하고 "이 하락은 노이즈인가, 악재인가"를 물어
`trade_audit`(kind `entry_review`, `correlation_id = review-<decisionId>`)에 남긴다. **주문에 영향을 주지
않고 주문도 기다리지 않는다.** 신호 30건이 쌓이면 AI가 거부한 쪽(`fraction 0`)과 나머지의 규칙 수익률을
비교해 거부권·비중으로 승격할지 정한다(원칙 13). 모델은 `analysis_model_config['entry_review']`.

## Cron Schedule (요약)

Cron은 node-cron으로 **인프로세스** 실행되고 스케줄은 UTC다 (`server/app.ts`의 `CRON_JOBS`):
`execute`(5분 호출, 5·10분 게이트), `reconcile`(10분), `digest`(매일 01:00 UTC), `review`(10분, 16-21 UTC).
시간당 분석 크론은 없다 — AI 분석은 `review`가 신호 종목에만 부른다.

- 스케줄 표 → [`server/CLAUDE.md`](server/CLAUDE.md)
- execute의 위험 단계·판단 단계, 차단기, quiet hours(00:00–09:59 KST) → [`api/CLAUDE.md`](api/CLAUDE.md)

**진입만 막고 청산은 절대 막지 않는다** — 일일 손실/거래 한도, 국면 필터, 예산 전부 진입만 막는다
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
