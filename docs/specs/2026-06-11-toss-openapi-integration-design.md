# 토스증권 Open API 실연동 설계

- 작성일: 2026-06-11
- 상태: 설계 확정 (구현 계획 대기)
- 관련: `lib/trading/`, `api/cron/execute.ts`, `api/cron/reconcile.ts`, `api/approve/[id].ts`, `lib/db/schema.ts`

## 1. 배경 / 문제

`lib/trading/`는 토스증권 Open API가 공개되기 전 **추정 스펙 기반 placeholder**로 작성되었다. API가 정식 오픈(`openapi.json`, base URL `https://openapi.tossinvest.com`)되면서 실제 스펙과의 격차가 드러났고, 2026-06-11 라이브 키로 인증·조회 엔드포인트를 검증한 결과 다음이 확인되었다.

- 인증·조회(`/oauth2/token`, `/accounts`, `/holdings`, `/buying-power`, `/prices`, `/sellable-quantity`) 정상 동작. 계좌 `accountSeq=1`, `BROKERAGE`, US 보유 11종목(소수점 수량).

격차는 단순 필드명 수준이 아니라 **인증 모델**과 **주문 동기/비동기 모델**이라는 구조적 차이다.

### 현재 구현의 핵심 문제

| # | 항목 | 현재 (placeholder) | 실제 스펙 |
|---|---|---|---|
| 1 | Base URL | `api.tossinvest.com` | `openapi.tossinvest.com` |
| 2 | 인증 | 정적 `Bearer ${SECRET_KEY}` + `X-App-Key` | OAuth2 client_credentials → `POST /oauth2/token`으로 access_token 교환 (24h, refresh 없음, **client당 1개·재발급 시 이전 토큰 즉시 무효화**) |
| 3 | 주문 응답 | `submitOrder()`가 `status/filledPrice/filledQuantity` **동기 반환** 가정 | `POST /api/v1/orders`는 **`{orderId, clientOrderId}`만** 반환. 체결은 `GET /api/v1/orders/{orderId}` 폴링 (`status` + `execution`) |
| 4 | 주문 경로 | `/v1/orders` | `/api/v1/orders` |
| 5 | 계좌 식별 | body `accountNo` (env `TOSS_ACCOUNT_NO`, 현재 공란) | 헤더 `X-Tossinvest-Account: {accountSeq}` (정수, `GET /accounts`로 조회) |
| 6 | 주문 포맷 | side/orderType 소문자, quantity/price `number` | `BUY`/`SELL`, `MARKET`/`LIMIT` 대문자, quantity/price **string(decimal)** |
| 7 | 멱등성 | 헤더 `X-Idempotency-Key` | body `clientOrderId` (≤36자, `[a-zA-Z0-9-_]`, **10분 TTL**) |
| 8 | 잔고 | `GET /v1/accounts/{no}/balances` | `GET /api/v1/holdings` (`HoldingsOverview`) |
| 9 | 에러 | 단순 텍스트 | `{ error: { code, message, data } }` envelope + 코드 분류 |

**3번이 가장 치명적**: 현재 `execute.ts`/`approve/[id].ts`는 주문 응답에서 동기로 `orderResult.status/filledPrice/filledQuantity`를 읽는다(`execute.ts:957-1212`, `approve/[id].ts:76-243`). 실제 API에서는 이 필드들이 존재하지 않아 모든 자동 주문이 "체결가 미확인 예상가 기록" 분기로 빠진다. 정상 동작 불가.

추가 발견: 현재 멱등키 `exec-${crypto.randomUUID()}-${symbol}-${side}`는 41자 이상으로 `clientOrderId`의 36자 제한을 초과한다.

## 2. 목표 / 비목표

### 목표
- `lib/trading/`를 실제 스펙으로 재구현 (OAuth2 토큰 관리 + 비동기 주문 + holdings 매핑 + 에러코드 처리).
- 호출부(`execute.ts`/`approve`/`reconcile`)의 동기 체결 가정 제거, 변경은 최소화.
- 안전장치 통합: `sellable-quantity`(초과매도 가드), `buying-power`(서킷브레이커), `market-calendar/US`(장 게이팅), `holdings`(정합성).

### 비목표
- FMP `live-price`를 토스 `prices`로 대체 (이번 범위 제외, 추후 고려).
- 금액 기반(`orderAmount`) 주문 도입 — **정수 수량 유지**.
- 이벤트/큐 기반 완전 비동기 아키텍처 (현 cron+Redis 구조에 과함, YAGNI).

## 3. 핵심 설계 결정 (브레인스토밍 합의)

| 결정 | 선택 | 근거 |
|---|---|---|
| 스코프 | trading 교체 + 안전장치 통합 | 실거래 안전성 확보 |
| 체결 확정 | **인라인 짧은 폴링 + reconcile 보강** | 빠른 정확성 + 안전망 |
| 주문 단위 | **정수 수량 유지** (string 직렬화만) | 최소 변경, 시간제약 없음 |
| 토큰 캐싱 | **Redis 캐싱 + 재발급 분산 락** | 콜드스타트 공유 + 무효화 race 방지 |
| 레이어 구조 | **접근 B — Facade가 체결까지 책임** | 비동기 복잡성을 lib/trading에 캡슐화, 호출부 변경 최소 |
| 미체결 자동취소 | **cancelOrder 도입** | 명시적 취소가 더 안전 |
| accountSeq | **동적 조회 + 캐싱** | env 불필요, 계좌 변경에 강건 |

## 4. 모듈 구조

```
lib/trading/
├── types.ts        # 도메인 타입
├── token.ts        # OAuth2 토큰 매니저 (Redis 캐싱 + 재발급 락)
├── client.ts       # 공통 fetch: 토큰 주입 + 계좌 헤더 + 에러코드 파싱 + 재시도
├── account.ts      # getAccountSeq / getHoldings / getBuyingPower / getSellableQuantity / cancelOrder
├── orders.ts       # issueOrder / getOrder + 파사드 executeBuyOrder/executeSellOrder
└── CLAUDE.md       # 갱신 (placeholder 문구 제거)
```

### 공개 인터페이스

```typescript
// orders.ts — 파사드 (execute/approve가 사용)
executeBuyOrder(symbol: string, quantity: number, clientOrderId?: string): Promise<OrderOutcome>
executeSellOrder(symbol: string, quantity: number, clientOrderId?: string): Promise<OrderOutcome>

// orders.ts — 저수준 (reconcile이 사용)
getOrder(orderId: string): Promise<OrderDetail>

// account.ts
getHoldings(): Promise<TossHolding[]>
getBuyingPower(currency: 'USD' | 'KRW'): Promise<number>
getSellableQuantity(symbol: string): Promise<number>
cancelOrder(orderId: string): Promise<void>
```

### 타입

```typescript
// 파사드 반환 — 인라인 폴링까지 끝낸 정규화 결과
interface OrderOutcome {
    orderId: string;
    clientOrderId: string;
    status: 'filled' | 'partial' | 'pending' | 'rejected' | 'canceled';
    filledQuantity?: number;   // execution.filledQuantity 파싱
    avgFilledPrice?: number;   // execution.averageFilledPrice 파싱
    rejectReason?: string;     // 에러코드/메시지
}

// 저수준 — reconcile/폴링용
interface OrderDetail {
    orderId: string;
    status: TossOrderStatus;   // PENDING|PENDING_CANCEL|PARTIAL_FILLED|FILLED|CANCELED|REJECTED|...
    filledQuantity: number;
    avgFilledPrice: number | null;
    canceledAt: string | null;
}

// HoldingsItem 정규화 (string → number)
interface TossHolding {
    symbol: string; quantity: number; avgPrice: number;
    currentPrice: number; pnl: number; marketCountry: string; currency: string;
}
```

`OrderOutcome`은 기존 `orderResult.status/filledPrice/filledQuantity`와 거의 동일한 모양이라, 호출부는 필드 매핑(`filledPrice`→`avgFilledPrice`, status 값 매핑)만 변경한다.

## 5. token.ts — OAuth2 토큰 매니저

```
getAccessToken(): Promise<string>
  1. Redis GET "toss:oauth:token" → 있고 만료 여유(>60s) 충분하면 반환
  2. 없으면 재발급 락 acquireLock("toss:oauth:refresh", 10s)
     - 획득: POST /oauth2/token (form-urlencoded, client_id=TOSS_APP_KEY, client_secret=TOSS_SECRET_KEY)
             → Redis SET "toss:oauth:token" (TTL = expires_in - 60s) → releaseLock
     - 실패: 짧게 대기 후 Redis 재조회(최대 N회) → 없으면 직접 발급 fallback
```

- 제약 "client당 토큰 1개·재발급 시 이전 토큰 즉시 무효화" → 락으로 동시 재발급 직렬화.
- 만료 여유 60s로 직전 만료 401 예방. 그래도 401이면 client가 1회 강제 재발급 후 재시도.
- Redis 미설정(로컬) → 매번 발급 fallback (락도 dev에서 `true` 반환).
- 신규 Redis 키: `toss:oauth:token`, `toss:account:seq`, 락 `toss:oauth:refresh`.

## 6. client.ts — 공통 요청 래퍼 + 재시도

```
tossFetch<T>(method, path, { query?, body?, account?: boolean }): Promise<T>
  - Authorization: Bearer <getAccessToken()>
  - account:true → X-Tossinvest-Account: <getAccountSeq()> 헤더
  - 200 → ApiResponse envelope에서 result 언랩 (단 /oauth2/token은 OAuth2 표준 형식)
  - 4xx/5xx → { error:{code,message,data} } 파싱 → TossApiError(code, message, status, data) throw
  - 401 invalid_token/Unauthorized → 토큰 강제 재발급 후 1회 재시도
```

### 재시도 정책

| 상황 | 정책 |
|---|---|
| GET 5xx/네트워크 | 지수백오프 2회 (기존 유지) |
| POST 5xx/429 (clientOrderId 있음) | **재시도 허용** — 동일 clientOrderId라 멱등 |
| 429 | `Retry-After` 헤더 존중 |
| 500 maintenance | `data.retryAfterSeconds` 존중 (cron 시간 내에서만) |
| 409 request-in-progress | 짧은 대기 후 재시도 |
| POST에 clientOrderId 없음 | 재시도 금지 |

`clientOrderId` 멱등성 덕분에 기존 "POST 절대 재시도 금지"를 안전하게 완화. 파사드는 항상 clientOrderId를 부여하므로 자동 주문 재시도는 안전.

## 7. orders.ts — 주문 발행 + 인라인 폴링

### clientOrderId (36자 제약 해결)

- 내부 `order_tracking.idempotencyKey`(기존, 길이 무제한)와 토스 `clientOrderId`(≤36자)를 **분리**.
- `clientOrderId = crypto.randomUUID()` (정확히 36자, `[a-zA-Z0-9-]` 충족).
- `order_tracking`에 `client_order_id text` 컬럼 추가 → 호출부가 생성·전달·저장.
- 인라인 폴링/POST 재시도는 **같은 clientOrderId** 재사용 → 멱등(중복주문 방지). 재시도는 수 초 내라 10분 TTL 안전.

### issueOrder (저수준)

```
issueOrder({ symbol, side, orderType:'MARKET', quantity, clientOrderId }): Promise<{orderId, clientOrderId}>
  - body: { clientOrderId, symbol, side:'BUY'|'SELL', orderType:'MARKET', quantity: String(quantity) }
  - account 헤더 부착
  - 409 idempotency-key-conflict (동일 키 다른 본문 = 버그 신호) → throw (재시도 X)
```

### 파사드 executeBuyOrder / executeSellOrder

```
1. validateOrderInputs(symbol, quantity)        // 기존 유지: 양의 정수
2. clientOrderId = 제공값 ?? crypto.randomUUID()
3. { orderId } = issueOrder(...)                 // 접수
4. 인라인 폴링: getOrder(orderId) 최대 3회, 간격 ~1.5s (총 ~4.5s; cron maxDuration 800s라 여유)
     FILLED          → OrderOutcome{ status:'filled', filledQuantity, avgFilledPrice }
     PARTIAL_FILLED  → 'partial' (체결분 기록 + 잔량 pending)
     REJECTED        → 'rejected' (+ rejectReason)
     CANCELED        → 'canceled'
     PENDING/PENDING_* → 'pending' (reconcile가 추후 확정)
5. return OrderOutcome
```

- 422 비즈니스 에러(`insufficient-buying-power`, `order-hours-closed`, `stock-restricted`, `account-restricted` 등) → 파사드가 `OrderOutcome{ status:'rejected', rejectReason: code }`로 **정규화**(호출부 분기 단순화).
- 진짜 시스템 오류(500/네트워크)는 throw 전파 → 기존 try/catch가 order_tracking을 'error'로 마킹.

### getOrder (저수준, reconcile 재사용)

```
getOrder(orderId): GET /api/v1/orders/{orderId}
  → Order.status + Order.execution.{filledQuantity, averageFilledPrice} 정규화 → OrderDetail
```

## 8. 안전장치 통합 (account.ts)

| 기능 | 통합 위치 | 동작 |
|---|---|---|
| `getSellableQuantity(symbol)` | execute/approve 매도 직전 | 매도수량 > 매도가능수량이면 **매도가능치로 클램프**(브로커상 없는 수량은 애초에 못 팖), 매도가능=0이면 스킵. pending-sell guard를 브로커 실측으로 보강 |
| `getBuyingPower('USD')` | execute 매수 결정 전 (run당 1회 캐시) | 현금 매수가능액 < 주문금액이면 매수 스킵 |
| `market-calendar/US` | execute 진입부 (run당 1회) | 휴장이면 조기 종료 → 불필요한 주문/`order-hours-closed` 예방 |
| `getHoldings()` | reconcile 정합성 | 브로커 보유 ↔ DB positions 비교 → 불일치 알림 (`checkConsistency` 보강) |
| `cancelOrder(orderId)` | reconcile | 30분+ PENDING 주문 자동 취소 + 알림. CANCEL_REJECTED(별도 레코드·원주문 복귀) 처리 |

- 안전장치 조회는 보조 가드: 실패 시 경고 로그 후 기존 로직 진행. 단 **매도가능수량**은 조회 실패 시 보수적으로 처리(강도는 구현 시 조정).

## 9. 호출부 변경

### api/cron/execute.ts (~356-455, ~930-1212)
- `OrderOutcome` 매핑: `'submitted'`→`'pending'`, `'filled'`→`'filled'`, `'rejected'`→`'rejected'`, `+ 'partial'/'canceled'`. `filledPrice`→`avgFilledPrice`.
- `'filled'`이면 실제 체결가가 들어오므로, 기존 "체결가 미확인 예상가" 분기는 `'pending'`일 때만 적용 → 정확도 향상.
- `clientOrderId = crypto.randomUUID()` 생성 → 파사드 + `createOrderTracking`에 전달.
- 매수 전 `getBuyingPower`, 매도 전 `getSellableQuantity` 가드 삽입. 진입부 `market-calendar/US` 게이팅.

### api/cron/reconcile.ts
- `submitted`/`pending` 주문에 `getOrder(tossOrderId)` 폴링 → FILLED면 자동 복구(`autoRecoverFilledOrders` 경로), 30분+ PENDING이면 `cancelOrder` 후 타임아웃 처리.
- `getHoldings()` ↔ DB positions 정합성 비교 추가. TODO 주석 3개 제거.

### api/approve/[id].ts (~76-243)
- execute와 동일한 `OrderOutcome` 매핑. 승인 시 `clientOrderId` 생성·전달.

### DB / env
- `order_tracking`에 `client_order_id text` 추가 → drizzle 마이그레이션 1건.
- env: `TOSS_APP_KEY`=client_id, `TOSS_SECRET_KEY`=client_secret(역할 명확화, 값 유지), **`TOSS_ACCOUNT_NO` 제거**(accountSeq 동적 조회). `.env.example` 동기화.

## 10. 테스트 전략

| 레벨 | 대상 | 방법 |
|---|---|---|
| 단위 | token.ts | fetch+Redis 모킹: 캐시 히트/미스, 만료 여유, 락 실패 fallback, 401 강제 재발급 |
| 단위 | client.ts | 에러코드 파싱, envelope 언랩, 재시도(GET/POST/429/409), Retry-After 존중 |
| 단위 | orders.ts | 폴링 상태 전이(FILLED/PARTIAL/PENDING/REJECTED), clientOrderId 멱등, 422→rejected |
| 단위 | account.ts | holdings/buying-power/sellable/seq 정규화(string→number), cancelOrder |
| 단위 | execute/approve | lib/trading 모킹 — OrderOutcome 매핑, 가드 분기 |
| 통합(수동) | 실 API | 읽기 전용만 자동화(accounts/holdings/prices). 주문은 라이브라 자동 테스트 제외 |

- 기존 `__tests__/toss-client.test.ts`는 새 모듈 구조로 재작성.
- 실거래 검증 절차: DRY_RUN 전체 플로우 검증 → 소액 수동 1건 확인.

## 11. 리스크 / 주의

- **라이브 키 노출**: 설계 과정에서 `.env.local` 평문이 대화 컨텍스트에 적재됨 → 위협 모델에 따라 키 회전 고려.
- **clientOrderId 10분 TTL** vs reconcile 30분 타임아웃: 재시도는 수 초 내라 무관하나, 동일 키 재사용 시점 정책을 구현 시 재확인.
- **부분 체결(PARTIAL_FILLED)**: 체결분/잔량 분리 기록 로직이 신규 → DB 정합성 테스트 필수.
- **인라인 폴링 지연**: 3회×1.5s가 cron 전체 처리량에 미치는 영향 모니터링(종목 수 많을 때).
