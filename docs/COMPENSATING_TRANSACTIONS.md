# 보상 트랜잭션 (Compensating Transactions) 설계

## 1. 개요

siglens-trader는 외부 브로커(Toss Securities)에 주문을 전송하고, 그 결과를 로컬 DB에 기록한다.
이 두 시스템 간에는 분산 트랜잭션이 불가능하다:

- Toss API 호출은 HTTP 요청이므로 로컬 DB 트랜잭션에 포함할 수 없다.
- 브로커에서 체결이 확인되었지만 DB 기록이 실패하면, 실제 포지션과 DB 상태가 불일치한다.
- 네트워크 에러 시 주문이 실제로 접수되었는지 확인할 수 없다.

이 문서는 각 실패 케이스에 대한 보상 트랜잭션 전략과 자동/수동 복구 메커니즘을 정의한다.

---

## 2. 전체 흐름도

```
사용자 승인 (approve)
    │
    ▼
┌─────────────────────┐
│  orderTracking 생성  │  ← 멱등성 키 기반, status='submitted'
│  (증거 기록)         │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Toss API 호출       │  ← placeOrder(idempotencyKey, symbol, side, qty)
└────────┬────────────┘
         │
    ┌────┼────┬────────┬────────┬────────┐
    │    │    │        │        │        │
    ▼    ▼    ▼        ▼        ▼        ▼
  filled submitted rejected  error  network  approve
    │    │    │        │     timeout   실패
    │    │    │        │        │        │
    ▼    ▼    ▼        ▼        ▼        ▼
 Case1  Case5 Case4  Case3   Case3   Case7
 Case2
 Case6
```

---

## 3. 케이스별 상세

### Case 1: Toss filled + DB 트랜잭션 성공 (정상 케이스)

**흐름:**
1. Toss API → `filled` 응답 (filledPrice 포함)
2. `db.transaction()` 내에서 `insertTrade` + `openPosition`/`closePosition` 실행
3. `orderTracking` → `status='filled'`, `filledPrice` 기록

**보상 필요:** 없음. 정상 완료.

---

### Case 2: Toss filled + DB 트랜잭션 실패

**시나리오:** 브로커에서 체결 확인되었지만, `insertTrade` 또는 포지션 업데이트 중 DB 에러 발생.

**증거:**
- `orderTracking` 레코드가 `status='filled'`로 남아있으나, `trades` 테이블에 대응 레코드 없음.

**자동 복구:**
- `reconcile` cron (10분 간격)이 `autoRecoverFilledOrders()` 호출
- filled 주문 중 matching trade가 없는 건을 찾아:
  1. `insertTrade` — 누락된 거래 기록 생성
  2. `openPosition` / `averageIntoPosition` (buy) 또는 `closePosition` / `reducePositionQuantity` (sell)
  3. `orderTracking` → `status='recovered'`
- 결과를 이메일로 통보

**수동 개입이 필요한 경우:**
- `filledPrice`가 0이거나 null인 경우 (Case 6 참조)
- 자동 복구 자체가 DB 에러로 실패한 경우

---

### Case 3: Toss 네트워크 에러 / 타임아웃

**시나리오:** HTTP 요청이 타임아웃되거나 네트워크 에러로 응답을 받지 못함.

**처리:**
- `orderTracking` → `status='error'`
- DB에 trade/position 변경 없음 (안전)
- 이메일 알림 발송

**보상 필요:** 없음 (DB 측은 깨끗함).

**주의:** 브로커 측에서 실제로 주문이 접수되었을 수 있다.
- TODO: Toss API 오픈 후 `getOrderStatus()`로 확인 → 체결되었으면 Case 2 복구 로직 적용

---

### Case 4: Toss rejected

**시나리오:** 브로커가 주문을 거부 (잔고 부족, 거래 제한 등).

**처리:**
- `orderTracking` → `status='rejected'`
- `pendingOrders` → `status='pending'`으로 되돌림 (재시도 가능)
- DB에 trade/position 변경 없음

**보상 필요:** 없음.

---

### Case 5: Toss submitted (미체결)

**시나리오:** 주문이 접수되었지만 아직 체결되지 않음 (지정가 주문 등).

**처리:**
- `orderTracking` → `status='submitted'`
- pending sell guard 활성화 (같은 종목 중복 매도 방지)
- 30분 타임아웃: `reconcile` cron이 `SUBMITTED_TIMEOUT_MS` 초과 주문을 `status='timeout'`으로 변경
- 매도 타임아웃 시 긴급 이메일 (브로커에 포지션이 남아있을 수 있음)

**보상 필요:**
- 타임아웃된 매도 주문은 수동 확인 필요 (브로커 측 포지션 상태 확인)
- TODO: Toss API 오픈 후 자동 취소 (`cancelOrder()`) 구현

---

### Case 6: Toss filled + filledPrice 없음

**시나리오:** 브로커가 체결을 확인했지만 체결가를 응답에 포함하지 않음.

**처리:**
- 주문 시점의 예상 가격(`expectedPrice`)으로 trade/position 기록
- `orderTracking` → `status='fill_price_unknown'`
- 이메일 알림: 실제 체결가 확인 필요

**자동 복구 (TODO):**
- Toss API 오픈 후: `getOrderStatus(orderId)`로 실제 체결가 조회
- `trade.price` + `position.avgPrice` 자동 수정

**수동 복구:**
- 대시보드에서 trade의 price를 수동 수정 (현재 미구현 — 직접 DB 수정 필요)

---

### Case 7: approve 실패 (pendingOrder 상태 전환 실패)

**시나리오:** `approvePendingOrder()` 호출 후 Toss API 호출 전에 에러 발생,
또는 Toss API 실패 후 `revertPendingOrder()` 실패.

**처리:**
- `approvePendingOrder()` 실패 → 주문 미전송, `pendingOrders`는 `pending` 유지
- Toss 실패 후 revert 실패 → `pendingOrders`가 `approved` 상태로 남지만 주문 미체결
  - `orderTracking`에 에러 기록이 있으므로 수동 확인으로 식별 가능

**보상 필요:**
- `approved` 상태이지만 `orderTracking`에 대응 `filled` 레코드가 없는 경우 → 수동으로 `pending`으로 되돌림

---

## 4. 자동 복구 메커니즘

### reconcile cron (`api/cron/reconcile.ts`)

10분 간격으로 실행되며, 다음 순서로 처리:

1. **타임아웃 처리:** `submitted` 상태인 주문 중 30분 초과 건 → `timeout` + 이메일 알림
2. **자동 복구:** `autoRecoverFilledOrders()` — filled 주문 중 trade 누락 건 자동 생성
3. **정합성 검사:** `checkConsistency()` — 불일치 건수 이메일 보고

### autoRecoverFilledOrders (`lib/db/recovery.ts`)

- 지난 24시간 내 `filled` 상태 주문 조회
- 각 주문에 대해 matching trade 존재 여부 확인
- 누락된 경우:
  - `filledPrice > 0` → DB 트랜잭션으로 trade + position 생성 → `status='recovered'`
  - `filledPrice <= 0` → `failed`로 집계, 수동 확인 요청

### checkConsistency (`lib/db/recovery.ts`)

- filled 주문 중 matching trade 없는 건수 보고 (autoRecoverFilledOrders 이후 실행되므로, 복구 실패 건만 남음)
- TODO: `filledOrdersWithoutPositions`, `openPositionsWithoutTrades` 체크 추가

---

## 5. 수동 복구가 필요한 케이스와 절차

| 케이스 | 식별 방법 | 절차 |
|--------|-----------|------|
| `filledPrice` 없는 체결 | `order_tracking.status = 'fill_price_unknown'` | 브로커 앱에서 실제 체결가 확인 → DB 직접 수정 (`trades.price`, `positions.avg_price`) |
| 자동 복구 실패 | 이메일 알림 "자동 복구 실패" | 에러 원인 확인 → DB 직접 수정 또는 재시도 |
| 매도 타임아웃 | `order_tracking.status = 'timeout'` + `side = 'sell'` | 브로커 앱에서 포지션 상태 확인 → 체결되었으면 수동으로 trade + position 닫기 |
| 네트워크 에러 후 실제 체결 | `order_tracking.status = 'error'` + 브로커에서 체결 확인 | 수동으로 `insertTrade` + position 업데이트 (또는 `status`를 `filled`로 변경 후 다음 reconcile에서 자동 복구) |
| approve 후 stuck | `pending_orders.status = 'approved'` + 대응 filled 없음 | `pending_orders.status`를 `pending`으로 수동 변경 |

### 수동 복구 시 주의사항

1. **항상 트랜잭션으로 처리:** trade와 position은 반드시 함께 수정해야 한다.
2. **orderTracking 상태 업데이트:** 수동 복구 후 `status`를 `recovered`로 변경하여 재처리 방지.
3. **이중 복구 방지:** 수동 복구 전에 `autoRecoverFilledOrders`가 이미 처리했는지 확인.
