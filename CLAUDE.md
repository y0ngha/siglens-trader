# siglens-trader — CLAUDE.md

## 프로젝트 개요

US 주식 자동매매 시스템. siglens-core의 AI 분석을 기반으로 매매 신호를 생성하고 실행한다.
개인용 (토스증권 약관 §5③ — 본인 매매 목적 한정).

---

## 레이어 구조

```
api/            → Vercel Serverless Functions (HTTP 핸들러)
src/            → React SPA (Dashboard UI)
lib/strategy/   → 도메인 순수 로직 (외부 의존 없음)
lib/analysis/   → 애플리케이션 레이어 (siglens-core 연동)
lib/trading/    → 인프라 (토스 API I/O)
lib/data/       → 인프라 (FMP, Yahoo Finance I/O)
lib/notification/ → 인프라 (Resend Email I/O)
lib/db/         → 인프라 (Neon PostgreSQL I/O)
```

### 의존 방향

```
api/ → lib/strategy, lib/analysis, lib/trading, lib/notification, lib/db
src/ → (API 호출만, lib 직접 import 금지)
lib/strategy/ → 외부 의존 없음 (순수 함수)
lib/analysis/ → @y0ngha/siglens-core, lib/data
lib/trading/ → 외부 HTTP (토스 API)
lib/data/ → 외부 HTTP (FMP, Yahoo), @y0ngha/siglens-core (타입만)
lib/notification/ → 외부 HTTP (Resend)
lib/db/ → @neondatabase/serverless, drizzle-orm
```

**금지 사항:**
- `src/` 에서 `lib/` 직접 import 금지 (API를 통해서만 통신)
- `lib/strategy/` 에서 외부 I/O 금지 (순수 함수 유지)
- `lib/trading/` 의 인터페이스 변경 시 `lib/strategy/`는 변경 불필요 (분리됨)

---

## 각 레이어 상세

### `lib/strategy/` (도메인)

매매 판단의 핵심 로직. 외부 의존 없는 순수 함수.

- `types.ts` — SignalScore, ScoreWeights, TradingSignal, 상수
- `signal-scorer.ts` — 분석 결과 → 0-100 점수 (가중 평균)
- `risk-manager.ts` — 포지션 사이징, 손절/익절 판단
- `decision.ts` — 점수 + 포지션 상태 → buy/sell/hold 결정 + reason 생성

테스트 100% 커버리지 유지.

### `lib/analysis/` (애플리케이션)

siglens-core의 submit/poll 패턴을 래핑하여 "분석 실행 → 결과 반환"을 단일 함수로 제공.

- `poll-until-done.ts` — 범용 폴링 유틸 (2초 간격, 10분 타임아웃)
- `run-{technical,news,options,fundamental,overall}.ts` — 각 분석 타입 실행기

### `lib/trading/` (인프라)

토스증권 Open API 클라이언트. 현재 placeholder — API 문서 확정 후 교체 예정.

- `types.ts` — TossOrderRequest, TossOrderResponse, TossBalance
- `toss-client.ts` — HTTP 클라이언트 (submitOrder, getBalances)
- `order.ts` — 편의 래퍼 (executeBuyOrder, executeSellOrder)

**중요**: `dry_run` 모드에서는 이 레이어가 호출되지 않음. 도메인과 완전 분리.

### `lib/data/` (인프라)

시장 데이터 어댑터. siglens 앱에서 복사/적응한 코드.

- `fmp-http.ts` — FMP HTTP 클라이언트
- `fmp-fundamental.ts` — FundamentalDataProvider 구현체
- `fmp-news.ts` — 뉴스 + 실적 일정 fetch
- `yahoo-options.ts` — 옵션 스냅샷 fetch

### `api/cron/` (스케줄러)

Vercel Cron으로 트리거되는 서버리스 함수.

- `_run-analysis-cron.ts` — 공유 팩토리 (DRY)
- `technical.ts`, `news.ts`, `options.ts`, `fundamental.ts` — 각 분석 cron
- `execute.ts` — 종합 판단 + 매매 실행

### `src/` (프론트엔드)

React SPA. API Routes만 호출하며, 서버 로직을 직접 import하지 않음.

---

## 커맨드

```bash
yarn dev              # Vite dev server (port 4300)
yarn build            # Production build
yarn typecheck        # tsc --noEmit
yarn lint             # ESLint
yarn test             # Vitest (all)
yarn test --coverage  # 커버리지 리포트
yarn db:generate      # Drizzle 마이그레이션 생성
yarn db:migrate       # 마이그레이션 실행
yarn db:seed          # Mock 데이터 삽입
```

---

## 설계 원칙

1. **도메인/인프라 분리** — 토스 API 형식이 바뀌어도 strategy 로직은 불변
2. **DRY_RUN 우선** — 실전 API 없이도 전체 플로우 테스트 가능
3. **판단 근거 추적** — 모든 거래에 reason 저장, 이메일에도 포함. 향후 AI 고도화 데이터로 활용 예정.
4. **설정 가능** — 모델, 가중치, 임계값, 종목 전부 대시보드에서 변경 가능
