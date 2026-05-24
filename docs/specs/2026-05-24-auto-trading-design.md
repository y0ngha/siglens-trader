# Auto-Trading System Design

> **Date**: 2026-05-24
> **Status**: Draft
> **Repo**: siglens-trader (독립)
> **Domain**: auto-trade.siglens.io

---

## 1. 개요

siglens-core의 AI 분석(기술적, 뉴스, 옵션, 펀더멘털, 종합)을 기반으로 US 주식 자동매매를 수행하는 개인용 시스템.

**핵심 제약:**
- 토스증권 Open API 약관 §5③: 시세 정보를 본인 매매 목적에 한하여 이용, 제3자 제공/배포/상업적 활용 금지
- Cloudflare Access로 외부 접근 완전 차단
- 오픈소스 배포 시 API 키만 `.env`로 분리하면 됨

---

## 2. 아키텍처

```
┌───────────────────────────────────────────────────────────────────┐
│  Vercel (auto-trade.siglens.io)                                   │
│  ┌── Cloudflare Access (이메일 OTP) ──────────────────────────┐   │
│  │                                                             │   │
│  │  ┌──────────────┐     ┌────────────────────────────────┐   │   │
│  │  │ React SPA    │     │ Serverless Functions            │   │   │
│  │  │ (Dashboard)  │────▶│                                │   │   │
│  │  │ Vite + PWA   │     │ /api/cron/*    ← Vercel Cron   │   │   │
│  │  └──────────────┘     │ /api/status    ← Dashboard     │   │   │
│  │                       │ /api/positions                  │   │   │
│  │                       │ /api/trades                     │   │   │
│  │                       │ /api/config                     │   │   │
│  │                       │ /api/approve/:id                │   │   │
│  │                       └───────┬────────────────────────┘   │   │
│  └───────────────────────────────┼────────────────────────────┘   │
└──────────────────────────────────┼────────────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────┐
         ▼                         ▼                     ▼
┌──────────────┐          ┌──────────────┐      ┌──────────────┐
│ siglens-core │          │siglens-worker│      │ Toss Open API│
│ (npm import) │          │ (LLM proxy)  │      │ (주문 실행)   │
└──────┬───────┘          └──────────────┘      └──────────────┘
       │
       ▼
┌──────────────┐   ┌──────────────┐
│ Upstash Redis│   │  Neon DB     │
│ (job queue)  │   │ (상태/이력)   │
└──────────────┘   └──────────────┘
```

---

## 3. 기술 스택

| 항목 | 선택 |
|------|------|
| 프레임워크 | Vite + React 19 (SPA) |
| 서버 함수 | Vercel Serverless Functions (maxDuration: 800s) |
| DB | Neon PostgreSQL + Drizzle ORM |
| Job Queue | Upstash Redis (siglens-core 내부, 기존 인스턴스 공유) |
| 스타일링 | Tailwind CSS v4 |
| 상태관리 | TanStack Query |
| 알림 | Email (Resend) |
| 인증 | Cloudflare Access (Zero Trust, 이메일 OTP) |
| 배포 | Vercel |
| 패키지 매니저 | Yarn 4 |

---

## 4. Cron 스케줄

```json
{
  "crons": [
    { "path": "/api/cron/technical",   "schedule": "0 22-23,0-5 * * 1-5" },
    { "path": "/api/cron/news",        "schedule": "0 22-23,0-5 * * 1-5" },
    { "path": "/api/cron/options",     "schedule": "0 22-23,0-5 * * 1-5" },
    { "path": "/api/cron/fundamental", "schedule": "0 22 * * 1-5" },
    { "path": "/api/cron/execute",     "schedule": "7 22-23,0-5 * * 1-5" }
  ]
}
```

- **technical/news/options**: 매시 정각 (US 장중 KST 22:00~05:59, 월~금)
- **fundamental**: 장 시작 시 1회 (KST 22:00)
- **execute**: 분석 cron 완료 후 7분 offset으로 매시 실행

### 4.1 Cron 실행 플로우

**분석 crons (technical, news, options, fundamental):**
```
1. CRON_SECRET 검증
2. DB에서 config 로드 (watchlist, 해당 분석 타입 활성 여부, 모델)
3. 비활성이면 early return
4. 종목별:
   a. 데이터 준비 (뉴스: FMP fetch, 옵션: Yahoo fetch, 펀더: FMP client 주입)
   b. submitXxxAnalysis({ modelId, userApiKey }) 호출
   c. pollUntilDone() — 결과 나올 때까지 while loop
   d. 결과를 Neon DB analysis_results에 저장
5. 완료
```

**execute cron:**
```
1. CRON_SECRET 검증
2. DB에서 config 로드 (매매 모드, 리스크 파라미터, 모델)
3. 종목별:
   a. DB에서 최신 분석 결과 조회 (tech + news + options + fundamental)
   b. 활성 분석이 모두 완료되었는지 확인 (미완료면 skip)
   c. submitOverallAnalysis() 호출 (하위 분석 캐시 hit 기대) → poll
   d. Overall 결과 + 개별 분석 → signal-scorer로 점수화
   e. risk-manager로 포지션 사이징
   f. 매매 모드별:
      - DRY_RUN: 가상 거래 기록 DB 저장
      - SEMI_AUTO: pending_orders 저장 + Email 알림
      - AUTO: Toss API 주문 실행 + 결과 DB 저장
4. 완료
```

---

## 5. 데이터 소스

| 데이터 | 소스 | 방법 |
|--------|------|------|
| 가격/바 | FMP | siglens-core 내부 (`createMarketDataProvider()`) |
| 뉴스 | FMP News API | auto-trader에서 직접 fetch (`lib/data/fmp-news.ts`) |
| 옵션 스냅샷 | Yahoo Finance | auto-trader에서 직접 fetch (`lib/data/yahoo-options.ts`) |
| 펀더멘털 | FMP | `FmpFundamentalClient` 어댑터 주입 (`lib/data/fmp-fundamental.ts`) |

- 뉴스, 옵션, 펀더멘털 어댑터는 siglens 앱에서 복사 (infrastructure 코드, core 영역 아님)
- siglens DB 의존 없이 완전 독립 운영

---

## 6. DB 스키마 (Neon PostgreSQL)

```sql
-- 감시 종목
CREATE TABLE watchlist (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 분석 모델 설정
CREATE TABLE analysis_model_config (
  id SERIAL PRIMARY KEY,
  analysis_type TEXT NOT NULL UNIQUE,  -- technical|news|options|fundamental|overall
  enabled BOOLEAN DEFAULT true,
  model_id TEXT NOT NULL,              -- claude-opus-4|gemini-2.5-flash|gpt-4o 등
  use_byok BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 분석 결과
CREATE TABLE analysis_results (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  result JSONB NOT NULL,
  model_id TEXT NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL,
  cron_run_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 포지션
CREATE TABLE positions (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,          -- long|short
  quantity INTEGER NOT NULL,
  avg_price NUMERIC NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  close_price NUMERIC,
  status TEXT DEFAULT 'open'  -- open|closed
);

-- 거래 이력
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,          -- buy|sell
  order_type TEXT NOT NULL,    -- market|limit
  quantity INTEGER NOT NULL,
  price NUMERIC NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  mode TEXT NOT NULL,          -- dry_run|semi_auto|auto
  cron_run_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 승인 대기 주문 (SEMI_AUTO)
CREATE TABLE pending_orders (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price_limit NUMERIC,
  analysis_summary TEXT,
  signal_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending'  -- pending|approved|rejected|expired
);

-- 일반 설정 (key-value)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 알림 설정
CREATE TABLE notification_config (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL UNIQUE,  -- email
  enabled BOOLEAN DEFAULT true,
  target TEXT NOT NULL,          -- email address
  events TEXT[] DEFAULT '{}'    -- trade_executed, approval_required, error, analysis_complete
);
```

### 6.1 config 테이블 초기값

| key | value |
|-----|-------|
| `trading_mode` | `"dry_run"` |
| `max_position_size` | `1000` (USD) |
| `max_total_exposure` | `5000` (USD) |
| `stop_loss_percent` | `3` |
| `take_profit_percent` | `5` |
| `buy_threshold` | `70` |
| `sell_threshold` | `30` |
| `analysis_timeframe` | `"1Day"` |

---

## 7. 매매 전략 모듈

### 7.1 Signal Scorer (`lib/strategy/signal-scorer.ts`)

분석 결과를 0~100 점수로 변환 (priority-weighted average, 합 26):

```
- 기술적 분석: trend, riskLevel, actionRecommendation.confidence → 가중치 8
- 뉴스 분석: overallSentiment → 가중치 6
- 옵션 분석: signals (bullish/bearish ratio) → 가중치 5
- 펀더멘털: overallSentiment → 가중치 4
- 종합 분석: integratedConclusionKo (keyword match) → 가중치 3
```

가중치는 대시보드에서 설정 변경 가능.

### 7.2 Risk Manager (`lib/strategy/risk-manager.ts`)

- 포지션 사이징: Kelly Criterion 또는 고정 비율
- 손절: 설정된 % 또는 기술적 분석의 keyLevels.support 기반
- 익절: 설정된 % 또는 기술적 분석의 priceTargets 기반
- 최대 동시 포지션 수 제한
- 최대 총 노출 금액 제한

### 7.3 Decision (`lib/strategy/decision.ts`)

```
Score ≥ 70 + 기존 포지션 없음 → BUY 신호
Score ≤ 30 + 기존 포지션 있음 → SELL 신호
그 외 → HOLD
```

임계값��� 대시보드에서 설정 변경 가능.

---

## 8. 매매 모드

| 모드 | 동작 |
|------|------|
| `dry_run` | 실제 주문 없음. 가상 거래만 DB에 기록. 성과 추적 가능. |
| `semi_auto` | 신호 발생 시 pending_orders에 저장 + Email 알림. 대시보드에서 승인/거절. |
| `auto` | 신호 발생 시 즉시 Toss API 주문 실행. |

초기에는 `dry_run`으로 운영하며 신뢰도를 쌓은 후 `semi_auto` → `auto`로 전환.

---

## 9. 대시보드 (React SPA)

### 9.1 페이지 구성

| 페이지 | 경로 | 내용 |
|--------|------|------|
| 상태 | `/` | 시스템 상태, 마지막 분석/거래 시각, 오늘 거래 수, 총 수익 |
| 포지션 | `/positions` | 현재 보유 종목, 수익률, 손절/익절 라인 |
| 거래내역 | `/trades` | 체결 이력, 모의/실전 구분, 필터/정렬 |
| 분석 로그 | `/analysis` | 종목별 최근 분석 결과 요약, 신호 강도 |
| 승인 대기 | `/pending` | SEMI_AUTO 대기 주문, 승인/거절 버튼 |
| 설정 | `/settings` | 아래 상세 |

### 9.2 설정 페이지

**일반:**
- 매매 모드 선택 (DRY_RUN / SEMI_AUTO / AUTO)
- 실행 주기 표시 (vercel.json에서 결정, 참고용)

**감시 종목:**
- 종목 추가/삭제/활성화 토글
- 심볼 + 회사명

**분석 설정:**
- 분석 타입별 활성/비활성 토글
- 분석 타입별 LLM 모델 선택 드롭다운
  - Claude Opus 4, Claude Sonnet 4, GPT-4o, Gemini 2.5 Pro, Gemini 2.5 Flash 등
- BYOK 사용 여부 토글 (활성 시 해당 provider의 env 키 사용)

**리스크 관리:**
- 최대 포지션 크기 (USD)
- 최대 총 노출 (USD)
- 손절 %
- 익절 %
- 매수/매도 신호 임계값

**알림:**
- Email 알림 활성/비활성
- 알림 ��상 이벤트 선택:
  - 매매 체결 시
  - 승인 요청 시 (SEMI_AUTO)
  - 오류 발생 시
  - 분석 완료 시

---

## 10. 프로젝트 구조

```
siglens-trader/
├── api/                           # Vercel Serverless Functions
│   ├── cron/
│   │   ├── _run-analysis-cron.ts  # Shared factory (NOT a route)
│   │   ├── technical.ts
│   │   ├── news.ts
│   │   ├── options.ts
│   │   ├── fundamental.ts
│   │   └── execute.ts
│   ├── status.ts
│   ├── positions.ts
│   ├── positions/[id]/close.ts    # Manual position close (atomic)
│   ├── trades.ts
│   ├── analysis.ts
│   ├── analysis/trigger.ts        # Manual analysis trigger
│   ├── config.ts
│   ├── pending.ts
│   ├── search.ts                  # Ticker search (FMP)
│   ├── approve/[id].ts
│   └── _lib/
│       ├── auth.ts                # Cloudflare Access / DISABLE_AUTH check
│       ├── cron-auth.ts
│       └── db.ts
├── src/                           # React SPA
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── pages/
│   │   ├── Status.tsx
│   │   ├── Positions.tsx
│   │   ├── Trades.tsx
│   │   ├── Analysis.tsx
│   │   ├── Pending.tsx
│   │   └── Settings.tsx
│   ├── components/
│   │   ├── Card.tsx
│   │   ├── Badge.tsx
│   │   ├── EmptyState.tsx
│   │   ├── ErrorFallback.tsx
│   │   ├── ErrorMessage.tsx
│   │   ├── LoadingSkeleton.tsx
│   │   └── TickerSearch.tsx
│   ├── mocks/                     # MSW handlers for dev:mock mode
│   │   ├── browser.ts
│   │   └── handlers.ts
│   └── lib/
│       └── api.ts
├── lib/                           # 서버 비즈니스 로직
│   ├── analysis/
│   │   ├── run-technical.ts
│   │   ├── run-news.ts
│   │   ├── run-options.ts
│   │   ├── run-fundamental.ts
│   │   ├── run-overall.ts
│   │   └── poll-until-done.ts
│   ├── trading/
│   │   ├── toss-client.ts
│   │   ├── order.ts
│   │   └── position.ts
│   ├── strategy/
│   │   ├── signal-scorer.ts
│   │   ├── risk-manager.ts
│   │   └── decision.ts
│   ├── data/
│   │   ├── fmp-fundamental.ts
│   │   ├── fmp-news.ts
│   │   └── yahoo-options.ts
│   ├── notification/
│   │   └── email.ts
│   └── db/
│       ├── schema.ts
│       ├── queries.ts
│       ├── index.ts
│       ├── migrate.ts
│       ├── seed.ts
│       └── clear.ts
├── drizzle/
├── public/
│   └── robots.txt
├── vercel.json
├── vite.config.ts
├── tsconfig.json
├── package.json
├── .env.example
└── .gitignore
```

---

## 11. 환경변수

```env
# Auth — set to true in .env.local for local development without Cloudflare Access
DISABLE_AUTH=

# Vercel Cron 인증
CRON_SECRET=

# siglens-core 인프라 (기존 인스턴스 공유)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
WORKER_URL=
WORKER_SECRET=

# 데이터 소스
FMP_API_KEY=
MARKET_DATA_PROVIDER=fmp

# BYOK — LLM 프리미엄 모델용 (대시보드에서 모델별 활성화)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=

# 토스증권 Open API
TOSS_APP_KEY=
TOSS_SECRET_KEY=
TOSS_ACCOUNT_NO=

# DB
DATABASE_URL=

# 알림
RESEND_API_KEY=
NOTIFICATION_EMAIL_FROM=noreply@siglens.io
```

---

## 12. 인증/보안

| 레이어 | 방법 |
|--------|------|
| 외부 접근 차단 | Cloudflare Access (이메일 OTP, auto-trade.siglens.io) |
| Cron 보호 | `CRON_SECRET` 헤더 검증 |
| SEO 차단 | `robots.txt` (Disallow: /) + `X-Robots-Tag: noindex` 헤더 |
| API Keys | 모두 Vercel 환경변수, 코드에 하드코딩 없음 |

---

## 13. 배포 설정

### Cloudflare DNS
- `auto-trade` CNAME → `cname.vercel-dns.com` (프록시 활성)

### Vercel 프로젝트
- Framework: Vite
- Root Directory: `.` (monorepo 아님, 단일 프로젝트)
- Build Command: `vite build`
- Output Directory: `dist`
- Domain: `auto-trade.siglens.io`
- Functions maxDuration: 800 (Pro)

### Cloudflare Zero Trust
- Application: `auto-trade.siglens.io`
- Policy: Allow — 이메일 `dev.y0ngha@gmail.com` + OTP

---

## 14. 향후 확장 (현재 스코프 밖)

- PWA Push Notification (VAPID)
- 국내 주식 지원 (KRX, 장시간 09:00~15:30)
- 백테스팅 모듈 (DRY_RUN 이력 기반 성과 분석)
- 텔레그램 봇 ��동
- 다중 계좌 지원
