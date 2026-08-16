# 2026-08-17 감사 대응 — 분석→매매 파이프라인 전면 수정

**작성일**: 2026-08-17
**상태**: 구현 완료
**대상**: 진입 경로 / 청산 경로 / 신호 품질 / 주문·상태 정합성 4축 감사에서 나온 전 항목

---

## 0. 요약

v0.20.0(실행 주기 단축) 직후 4축 감사를 돌렸다. 발견 항목 중 **v0.20.0이 만든 것은 두 개**
(락 TTL 대비 실행 시간, 손절 후 재진입 간격)이고 나머지는 그 이전부터 있었다. 주기 단축이
노출 빈도를 6배로 키웠을 뿐이다.

가장 무거운 것은 **세 번째 죽은 추출**이었다. `safeAnalysisPrice`가 읽던
`keyLevels.currentPrice`는 siglens-core에 존재하지 않는 필드라 프로덕션에서 항상 0을
반환해 왔고, 그 결과 문서가 "활성 가드"로 설명하던 25% 시세 교차검증이 **한 번도 발동한 적이
없었다.**

---

## 1. Blocker

### 1.1 `safeAnalysisPrice` — 분석 폴백 가격이 존재하지 않았다

core의 `KeyLevels`는 `{ support, resistance, poc }` 셋뿐이고, `normalizeKeyLevels`가 객체를 그
세 키로 **재구성**하며, `currentPrice`는 core 타입 전체에 등장하지 않는다. 응답 스키마도
`additionalProperties: false`다. 즉 LLM이 그 필드를 내더라도 저장 전에 버려진다.

- 25% 교차검증(`MAX_PRICE_SOURCE_DIVERGENCE`)의 `snapshotPrice > 0`이 성립한 적 없음 → 가드 사망
- FMP 호가 실패 = 그 심볼 매수·평가 불가 (`skipped_no_price`)
- 호가 없는 포지션의 미실현 손익이 항상 0 → 일일 손실 차단기 과소 계상

**수정**: 함수를 삭제하고, 폴백 가격을 **컨플루언스 스냅샷의 `close`**(FMP OHLC 마지막 봉
종가)로 바꿨다. 교차검증 주석이 원래 의도한 비교(quote 엔드포인트 vs OHLC)가 정확히 이 둘이고,
execute cron이 이미 심볼당 한 번 계산해 캐시하므로 추가 조회가 없다.

**왜 이 버그가 릴리스를 넘겼나**: 테스트 픽스처와 `db:seed`가 core가 내지 않는 모양
(`keyLevels: { currentPrice: 150 }`)을 쓰고 있었다. `support`/`priceTargets`에서 두 번 겪은 것과
같은 메커니즘이다. 이번에 픽스처에서 그 필드를 전부 제거했다.

### 1.2 수동 청산이 브로커에 주문을 내지 않았다

`POST /api/positions/:id/close`가 `lib/trading`을 전혀 호출하지 않아, `auto`에서 누르면 DB만
닫히고 실주식은 브로커에 남았다. 그 주식은 `getOpenPositions`에서 사라지므로 재평가·손절·강제
청산 어디에도 도달하지 못하는 **유령 보유**가 된다.

**수정**: `auto`에서 실제 매도 주문을 내고, **체결이 확정된 경우에만** DB 포지션을 닫는다.
미확정이면 202 + `order_tracking`을 남겨 reconcile이 확정한다. 기록 모드도 하드코딩
(`'semi_auto'`)에서 실제 `trading_mode`로 바꿨다 — 종전에는 dry_run 청산이 실계좌 일일 손실
차단기 입력에 섞였다. 청산가도 `avgPrice` 즉시 폴백에서 호가 → avgPrice 순으로 바꿔 실현 손익이
0으로 기록되던 문제를 없앴다.

### 1.3 락 TTL < 최대 실행 시간 → 동시 실행 (v0.20.0이 만든 것)

`acquireLock(…, 780)`의 주석은 이제 존재하지 않는 Vercel `maxDuration`(800초)을 상한으로
가정했는데, EC2 Node 서버에는 실행 시간 상한이 없다. FMP가 429를 지속하면 한 실행이 20분을
넘길 수 있고, 그때 TTL이 만료되면 다음 틱이 락을 새로 잡는다. 두 실행은 각자
`currentExposure`·매수여력·in-flight 스냅샷을 들고 돌므로 같은 심볼에 주문이 두 번 나간다.
`cronRunId`가 다르니 멱등키도 걸리지 않는다.

| 실행 간격 | 락 만료 후 첫 틱 | 동시 실행 임계 실행시간 |
|---|---|---|
| 60분 (v0.19) | T+3600s | 3600s — 사실상 도달 불가 |
| 10분 (v0.20) | T+1200s | **1200s** |

**수정** 세 겹:
- `server/app.ts`에 **`noOverlap: true`** (node-cron 4.6의 기본값은 false였다)
- 락 TTL 780 → **1800초**
- 실행 하드 데드라인 **900초** — 그 시각을 넘기면 남은 심볼을 `run_deadline`으로 남기고 루프를
  빠져나온다. 진행 중이던 호출 하나(최악 ~135초)를 더해도 약 1035초라 TTL 안쪽에 머문다.

### 1.4 reconcile ↔ execute 이중 기록

`recovery.ts`의 "reconcile이 락을 잡고 있어 동시 수정이 없다"는 주석이 틀렸다 — 락 키가 다르다
(`cron:execute:lock` vs `cron:reconcile:lock`). execute의 booking 트랜잭션이 커밋되기 전에
reconcile이 같은 주문을 복구하면 체결 1건에 trade 2행 + 포지션 2회 변경이 된다.

**수정**: `trades.client_order_id`에 **partial unique 인덱스**(마이그레이션 `0014`). 코드로 창을
좁히는 대신 DB 제약으로 불가능하게 만든다 — 두 번째 insert가 실패하며 그쪽 트랜잭션이 롤백된다.

> **배포 주의**: 이미 중복 행이 있으면 마이그레이션이 실패한다. 실패하면 그 자체가 이중 기록이
> 이미 발생했다는 증거이므로, 중복을 확인·정리한 뒤 다시 적용해야 한다.

### 1.5 `error` 주문이 종료 상태로 빠져 다시 조회되지 않았다

`getPendingSubmittedOrders`가 `submitted/pending/partial`만 봤다. Toss POST가 타임아웃되거나
`idempotency-key-conflict`를 내면 execute는 `error`로 기록하고 끝나는데, **그 둘은 "브로커가
주문을 받지 않았다"는 뜻이 아니다** — 특히 멱등키 충돌은 브로커가 이미 그 주문을 갖고 있다는
신호다. 결과적으로 (1) 체결이 장부에서 사라지고 (2) 다음 틱이 in-flight가 없다고 보고 같은
심볼에 두 번째 주문을 냈다.

**수정**: `INFLIGHT_ORDER_STATUSES`에 `error`를 넣어 확정 전까지 in-flight로 취급한다.
일일 in-flight 카운트에도 포함시켰다.

---

## 2. High

| 항목 | 수정 |
|---|---|
| `getSellableQuantity` 파싱 실패가 `0`(="못 판다") | `number \| null`로 바꿔 **읽을 수 없음**을 null로 표현. 호출부는 null을 "가드 비활성"으로 이미 처리한다 (청산 fail-open) |
| `avgFilledPrice = 0`이 clean-fill 판정을 통과 | `getOrder`가 유한 양수만 반환하고, 4개 호출부(execute ×2, reconcile, approve)가 `isFinitePositive`로 검사 |
| stale 분석 시 청산 전부 정지 + 무알림 | 실행당 **한 통**으로 묶어 알림. 심볼별로 보내면 10분 간격 × 종목 수로 받은편지함이 죽는다 |
| `averageIntoPosition` rowCount 미확인 | `Promise<boolean>`으로 바꾸고 4개 호출부가 `POSITION_ALREADY_CLOSED`로 롤백. 매도 경로는 원래 하던 것을 매수만 안 하고 있었다 |
| 손절 직후 10분 재진입 | 쿨다운 기준을 "마지막 **매수** 체결"에서 "마지막 **체결**"로 넓혔다. 매도도 쿨다운을 건다 |
| 4축 신선도 미검사 (최대 31점 왜곡) | `getCadenceWindowMs(type) × 3`을 넘긴 뉴스/옵션/펀더멘털/의회 행을 `null`로 떨어뜨린다. 낡은 값이 방향을 주장하는 것보다 중립이 낫다 |
| semi_auto 대기 매수가 노출에서 소멸 | `pending_orders`의 미승인 매수도 `pendingBuyExposure`에 합산 |
| `cancelOrder` 실패를 삼키고 종료 상태로 | 취소 성공을 확인한 뒤에만 `timeout`/`needs_review`로 넘긴다. 실패하면 상태 유지 + 알림 → 다음 실행 재시도 |
| recovery의 경합이 재시도 대신 파킹 | `POSITION_ALREADY_CLOSED`는 1시간 동안 재시도(=최대 6회), 그 뒤에도 실패하면 `needs_review` |
| 컨플루언스 기권이 진입 fail-open | 스냅샷이 `null`이면 매수를 `hold`로 내린다. 매도·청산은 그대로 |

### 2.1 컨플루언스 기권 규칙의 근거

다른 5축을 고정하고 컨플루언스만 바꾸면, 같은 종목이 컨플루언스 50(진짜 중립)일 때 65(hold)인데
스냅샷이 `null`이면 72(buy)가 된다. 시장은 하나도 변하지 않았고 FMP가 봉을 못 줬을 뿐이다.
"지표가 받쳐주지 않는 진입은 하지 않는다"고 넣은 축이 **지표를 확인할 수 없을 때 통째로 열리는**
구조였다. 놓친 매수는 기회비용, 놓친 매도는 실현 손실 — 기존 비대칭과 같은 방향으로 맞췄다.

---

## 3. Medium

- **`entryRecommendation` 폭 축소** (+20/−15/−25 → +10/−6/−12). 종전 폭 45점은 `TREND_SPAN`
  ±35(=70점)의 64%라 리터럴 한 단어가 지표 집계를 뒤집었다(지표 100% 강세인데 `avoid`면 60,
  지표 완전 중립인데 `enter`면 70). 더 나쁜 것은 중립점 이동이었다 — 6축 전부 중립인 종목이
  `avoid` 하나로 45가 되어 매수는 +25, 매도는 −15가 필요한 비대칭이 상시화됐다.
- **`avoid`는 이제 게이트가 막는다** (`entry_not_recommended`). 명시적 거부를 5점짜리 감점으로
  표현하려던 것이 애초에 잘못된 층이었다. `entryPrices` 게이트도 이걸 못 잡는다 — core는
  `avoid`에서도 "돌파 시 진입" 조건부 구간을 채우고, 그 구간은 대개 현재가 **위쪽**이라 상단
  검사를 통과한다.
- **`mapTrend`가 죽은 코드였다.** 지표 시그널이 하나라도 있으면 종합 `trend`를 버렸는데, core
  스키마에서 `indicatorResults`는 required라 그 폴백은 실전에서 도달하지 않았다. 결과적으로
  **진입은 시그널 카운트를, 청산(`technicalTrend`)은 종합 판정을** 보고 있었다. 이제 셋
  (시그널 집계 / 패턴·전략·캔들 집계 / 종합 trend)을 평균한다.
- **`patternSummaries` / `strategyResults` / `candlePatterns` 배선.** core가 방향과
  `confidenceWeight`까지 계산해 주는 신호 세 묶음이 어디에서도 읽히지 않았다. 죽은 추출이
  아니라 **미배선**이었다.
- **승인 경로 리스크 차단기 재확인.** 매수 승인에 한해 일일 손실·거래 한도를 다시 본다. 대기
  주문은 큐잉 후 승인까지 최대 15분이 비는데, 그 사이 한도가 터져 전 종목이 강제청산돼도 승인
  버튼은 그대로 신규 진입을 체결시켰다. `CLAUDE.md`가 면제한다고 명시한 것은 **진입 시간 창**
  뿐이다.
- **같은 틱 매도→매수 차단** (`entry_after_exit_blocked`). 부분 익절로 노출이 줄면 그만큼 예산이
  풀려 같은 틱의 워치리스트 루프가 방금 판 종목을 되샀다.
- **구조 훼손을 게이트에 `structural`로 알린다.** 지지선 이탈·추세 반전·지표 반전·분석 손절가
  이탈은 수익 구간이면 `take_profit`으로 라벨링되는데(손절 이력 오염 방지), 그 라벨을 그대로
  넘기면 프롬프트가 '익절'을 읽고 "목표 달성형이니 일부만"으로 판단한다.
- **dry_run 실현 손익.** `getTodayRealizedPnl(db, tradingMode)` — dry_run에서는 dry_run 체결이
  유일한 실현 손익이다. 제외하면 리허설이 실전보다 관대해진다.
- **`realizedPnl` NaN 방어.** Postgres numeric은 NaN을 저장하고 SUM에 하나만 섞여도 결과가
  NaN이 된다. 그러면 `todayPnl < -limit`이 **항상 false**라 그날 내내 차단기가 침묵한다.
  `realizedPnlForSell`이 0으로 떨어뜨리고, 집계 쿼리도 NaN 행을 뺀다.
- **물타기 분리** (`average_down_enabled`, 기본 **꺼짐**). 종목 예산은 `현재가 × 보유수량`을
  빼므로 **가격이 내릴수록 살 수 있는 금액이 커지고**, 고정 손절선은 평단 기준이라 물타기로
  평단이 내려가면 손절선도 함께 내려간다. 두 효과가 같은 방향으로 겹쳤다.
- **승인 재시도.** `createOrderTracking`을 upsert로. `approve-{id}`가 고정 멱등키라 1차 승인이
  실패해 되돌아간 주문은 재승인 시 유니크 위반으로 항상 502였다 — Toss를 호출조차 하지 않고.
- **실행 주기 × 진입 창 교집합 검증.** 두 값의 교집합이 비면 매수가 영구히 0이 되는데 로그에는
  `outside_entry_window`만 남아 설정 오류와 정상 상태가 구분되지 않는다. 저장 시점에 거부한다.

---

## 4. Low

- cron 스케줄 `7-59/5` → **`2-59/5`**. 종전 표현식은 :02를 빼먹어 `execute_interval_min = 5`에서
  :57 → 다음 시 :07이 10분 공백이었다.
- **지각 틱 허용** 1분. 게이트가 분 단위 등식이라 관용 구간이 없으면 이벤트 루프 지연으로 진입이
  밀린 틱이 통째로 사라졌다 — `startCronRun`보다 앞이라 감사 흔적도 없다.
- `CRON_STALE_AFTER_MS` 15분 → **30분**. 아직 살아 있는 실행의 감사 행을 다음 크론이
  `error/timeout`으로 덮어쓰고, 그 실행이 끝나면 다시 `completed`로 덮여 `timeout` 값 자체가
  신뢰할 수 없었다.
- 문서의 "weights sum to 38"은 `1Hour` 프로파일 기준이다. `15Min`은 39다 (가중 평균이라 산술
  문제는 없다).

---

## 5. 의도적으로 하지 않은 것

- **뉴스 `priceImpact` 반영.** 데이터는 `news_cards.card` JSONB에 이미 있지만, 점수 입력은
  `analysis_results`에서 오므로 심볼당 틱당 쿼리를 하나 더 붙여야 한다. 효과 대비 비용이
  맞지 않아 별도 작업으로 남긴다 — `negligible` 10건으로 만든 bullish와 실적 서프라이즈
  `high` 1건으로 만든 bullish가 같은 80점인 것은 사실이다.
- **dry_run 공휴일 게이트.** `isUsMarketOpen`은 브로커 API 호출이라 시뮬레이션에서 부르지
  않는다. core에 휴장일 테이블이 없어 대체 수단도 없다.
- **컨플루언스 `expected` vs `confirmed` 구분.** `bollinger_squeeze_*` 같은 예측 시그널이
  확정 시그널과 동일하게 세어져 확정 이벤트 없이 트리거가 설 수 있다. 다만 백테스트 원문이
  phase를 구분했는지 확인되지 않아, 근거 없이 룰을 바꾸지 않는다.
