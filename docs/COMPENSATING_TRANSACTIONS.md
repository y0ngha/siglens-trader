# 보상 트랜잭션 — 실제 동작 방식

## 왜 필요한가

Toss API에 주문을 보내고, 그 결과를 DB에 기록하는 2단계 작업은 한쪽만 성공할 수 있다.
브로커에서 주식을 샀는데 DB에 기록을 못 하면, 시스템은 그 주식을 모르는 상태가 된다.
이걸 막기 위해 모든 실패 케이스에 대해 보상 처리를 설계했다.

---

## 실행 순서

모든 auto 모드 주문은 이 순서로 진행된다:

```
1. orderTracking 테이블에 기록  (증거 먼저)
2. Toss API 호출               (실제 주문)
3. orderTracking 상태 갱신      (결과 반영)
4. db.transaction {             (원자적 DB 기록)
     insertTrade
     openPosition / closePosition / reducePositionQuantity
   }
```

step 1이 먼저인 이유: step 2에서 뭔가 잘못되어도 "주문을 시도했다"는 증거가 남는다.

---

## 케이스별 실제 동작

### Case 1: DB 트랜잭션 내부 실패

```
trade 기록 성공 → position 기록 실패
```

**실제 동작**: `db.transaction()` 안에서 하나라도 실패하면 전체 rollback. trade도 position도 안 남음. 깨끗한 상태.

**사용자 영향**: 없음. 다음 cron에서 다시 시도.

---

### Case 2: Toss에서 체결 + DB 기록 실패

```
브로커: 주식 샀음 ✓
DB: 기록 안 됨 ✗
```

**실제 동작**:
1. catch 블록에서 이메일 알림 발송 ("거래 기록 실패, 수동 확인 필요")
2. `orderTracking`에는 `status: 'filled'`로 남아있음 (step 3에서 이미 갱신됨)
3. **10분 뒤 reconcile cron이 자동 복구**:
   - `orderTracking`에서 `filled`인데 매칭 trade가 없는 건 발견
   - 자동으로 `insertTrade` + `openPosition`/`closePosition` 생성
   - `orderTracking` → `status: 'recovered'`
   - 복구 결과 이메일 발송

**사용자 영향**: 최대 10분간 포지션이 DB에 안 보임. reconcile cron이 자동 복구.

**자동 복구 불가한 경우**: `filledPrice`가 없으면 (Case 6) 자동 복구 못 함 → 이메일로 수동 확인 요청.

---

### Case 3: Toss API 네트워크 에러 / 타임아웃

```
브로커: 주문 도착했는지 모름
DB: 변경 없음 ✓
```

**실제 동작**:
1. `orderTracking` → `status: 'error'`
2. trade/position 변경 안 함 (시도 안 함)
3. 이메일 알림

**사용자 영향**: 없음. DB는 깨끗. 단, 브로커에 실제로 주문이 접수됐을 수 있음.

**TODO**: Toss API 오픈 후 `getOrderStatus()`로 실제 접수 여부 확인 → 체결됐으면 Case 2 복구 로직 적용.

---

### Case 4: Toss가 주문 거부 (rejected)

```
브로커: 안 샀음
DB: 변경 없음 ✓
```

**실제 동작**:
1. `orderTracking` → `status: 'rejected'`
2. approve 경로: `revertPendingOrder()` → 상태를 `pending`으로 되돌림 (재시도 가능)
3. 이메일 알림
4. trade/position 변경 없음

**사용자 영향**: 없음. 사용자가 대시보드에서 다시 승인 가능.

---

### Case 5: Toss가 접수만 함 (submitted, 미체결)

```
브로커: 주문 접수됨, 체결 대기 중
DB: 변경 없음 ✓ (체결 전이므로)
```

**실제 동작**:
1. `orderTracking` → `status: 'submitted'`
2. trade/position 변경 안 함
3. 이메일 알림 ("미체결 주문")
4. **pending sell guard 활성화**: 다음 cron에서 같은 종목 재매도 방지
5. **30분 후 reconcile cron**: 타임아웃 처리
   - 매도 주문 타임아웃: [긴급] 이메일 (브로커에 포지션 남아있을 수 있음)
   - 매수 주문 타임아웃: 일반 이메일

**사용자 영향**: 이메일 받고 브로커 앱에서 직접 확인 필요.

**TODO**: Toss API 오픈 후 `getOrderStatus()`로 체결 확인, `cancelOrder()`로 미체결 취소.

---

### Case 6: Toss 체결 + 체결가 없음

```
브로커: 주식 샀음 ✓
응답: filledPrice가 null
```

**실제 동작**:
1. 주문 시점의 예상가(분석가/현재가)로 trade + position 기록 (기록 안 하는 것보다 나음)
2. reason에 "체결가 미확인 — 예상가 $X로 기록" 명시
3. `orderTracking` → `status: 'fill_price_unknown'`
4. 이메일 알림 ("실제 체결가 확인하여 수정해주세요")

**사용자 영향**: 포지션은 추적되지만 가격이 정확하지 않음. 수동으로 DB 수정 필요.

**TODO**: Toss API 오픈 후 `getOrderStatus(orderId)`로 실제 체결가 조회 → 자동 수정.

---

### Case 7: approve 실패 (거래 기록 중 에러)

```
approve 상태 변경: 'approved' ✓
trade 기록: 실패 ✗
```

**실제 동작**:
1. catch 블록에서 `revertPendingOrder()` → 상태를 `pending`으로 되돌림
2. 이메일 알림
3. 사용자가 대시보드에서 다시 승인 가능

**auto 모드에서 Toss 성공 + DB 실패**: Case 2와 동일하게 처리. `orderTracking`에 증거 남음 → reconcile cron 자동 복구.

---

## 자동 복구 시스템

### reconcile cron (10분마다 실행)

3단계 순서로 처리:

```
1단계: 타임아웃 처리
  - submitted 상태 주문 중 30분 초과 → timeout + 이메일

2단계: 자동 복구 (autoRecoverFilledOrders)
  - filled 상태인데 trade 없는 건 발견
  - filledPrice 있으면 → trade + position 자동 생성 → recovered
  - filledPrice 없으면 → 실패 처리 (수동 확인 필요)

3단계: 정합성 검사 (checkConsistency)
  - 2단계에서 복구 못 한 건 + 기타 불일치 → 이메일 알림
```

### 전체 흐름도

```
Toss API 호출
  ├─ throw (네트워크) → status='error' + 이메일 → DB 변경 없음 ✅
  ├─ rejected → status='rejected' + revert + 이메일 → DB 변경 없음 ✅
  ├─ submitted → status='submitted' + 이메일 + 재매도 방지 → DB 변경 없음 ✅
  │                                                    └─ 30분 후 timeout
  └─ filled
       ├─ filledPrice 있음
       │    ├─ DB 성공 → trade+position 기록 ✅
       │    └─ DB 실패 → status='filled' 증거 + 이메일 → 10분 후 자동 복구 ✅
       └─ filledPrice 없음 → 예상가로 기록 + 이메일 ⚠️ (TODO: 자동 수정)
```

**✅ = 자동 처리**, **⚠️ = 수동 확인 필요 (Toss API 오픈 후 자동화 예정)**

---

## 수동 복구 절차

| 상황 | 어떻게 알 수 있나 | 뭘 해야 하나 |
|------|-------------------|-------------|
| 체결가 없는 거래 | 이메일 + `order_tracking.status = 'fill_price_unknown'` | 브로커 앱에서 실제 가격 확인 → DB의 `trades.price`와 `positions.avg_price` 수정 |
| 자동 복구 실패 | 이메일 "자동 복구 실패" | 에러 원인 확인 → 수동으로 trade + position 생성 |
| 매도 타임아웃 | 이메일 [긴급] | 브로커 앱에서 포지션 확인 → 체결됐으면 `order_tracking.status`를 `filled`로 변경 → 다음 reconcile에서 자동 복구 |
| 네트워크 에러 후 실제 체결 | 브로커 앱에서 직접 확인 | `order_tracking.status`를 `filled`로 + `filledPrice` 설정 → 다음 reconcile에서 자동 복구 |
