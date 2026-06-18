# 크론 분석 신선도 및 운영 신뢰성 개선 설계

작성일: 2026-06-18  
대상: `siglens-trader`

## 1. 목표

미국 장중 기술 분석이 설정된 분봉 주기에 맞춰 새 차트로 갱신되도록 하고, 분석 결과의 실제 생성 시각을 보존한다. 동시에 미종결 크론 감사 기록, 설명 없는 매매 결정, 뉴스 카드 장시간 실행, 암묵적 운영 설정을 제거한다.

## 2. 확정 요구사항

- 기술 분석 타임프레임은 `15Min`, `30Min`, `1Hour`만 허용한다.
- 기본값은 `1Hour`다.
- 기술 분석 호출은 `force: false`를 유지한다.
- 캐시 결과를 DB에 저장할 때 캐시 원본의 `result.analyzedAt`을 별도 컬럼에 보존한다.
- execute 크론의 기술 분석 신선도 검사는 DB 저장 시각이 아니라 원본 분석 시각을 우선 사용한다.
- 15분 이상 `running`인 크론 기록은 삭제하지 않고 `error/timeout`으로 종결한다.
- `hold` 결정에도 판단 사유와 축별 점수를 감사 테이블에 저장한다.
- 뉴스 카드 생성은 최신 10개 기사, 동시 처리 최대 3개로 제한한다.
- 뉴스 크론 실행 제한시간이 가까워지면 신규 카드 제출을 중단한다.
- `@y0ngha/siglens-core`를 `0.23.0` 이상으로 통일한다.
- 운영 설정과 분석 모델 설정을 마이그레이션으로 명시 저장하되 기존 값을 덮어쓰지 않는다.

## 3. 기술 분석 타임프레임

### 3.1 설정 계약

`config.analysis_timeframe`의 허용값을 다음으로 축소한다.

```ts
type AnalysisTimeframe = '15Min' | '30Min' | '1Hour';
```

설정 API는 다른 값을 거부한다. 설정 화면에는 다음 선택지만 표시한다.

- 15분
- 30분
- 1시간

설정이 없거나 기존 값이 허용 범위 밖이면 런타임 기본값 `1Hour`를 사용한다. 마이그레이션은 키가 없을 때만 `1Hour`를 삽입한다. 기존 운영 DB에 `1Day`가 있으면 배포 마이그레이션에서 `1Hour`로 명시 변환한다. 이 변환은 요구사항에 따른 의도적 운영 설정 변경이다.

### 3.2 캐시 동작

기술 크론은 `submitAnalysis(..., force=false)`를 유지한다. siglens-core의 타임프레임별 기술 분석 캐시 TTL을 이용한다.

| 설정 | 최대 기술 분석 캐시 TTL |
|---|---:|
| `15Min` | 15분 |
| `30Min` | 30분 |
| `1Hour` | 1시간 |

크론은 매시간 실행되므로 기본 `1Hour` 설정에서 이전 장 전체를 재사용하는 문제는 제거된다. 캐시가 남아 있는 경계 시점에는 동일 결과가 반환될 수 있으므로 원본 분석 시각을 보존하고 execute에서 신선도를 별도로 검증한다.

## 4. 분석 생성 시각과 신선도

### 4.1 스키마

`analysis_results`에 nullable 컬럼을 추가한다.

```sql
source_analyzed_at TIMESTAMPTZ NULL
```

- `analyzed_at`: trader가 결과 행을 저장한 시각
- `source_analyzed_at`: LLM 분석 결과가 실제 생성된 시각

기존 행은 원본 시각을 알 수 없으므로 `NULL`로 유지한다.

### 4.2 저장 규칙

분석 결과가 객체이고 `result.analyzedAt`이 유효한 ISO 시각이면 `source_analyzed_at`에 저장한다. 없거나 잘못된 값이면 신규 생성 결과는 현재 저장 시각을 사용하고, 기존 데이터 마이그레이션에서는 `NULL`을 유지한다.

이 파싱은 공용 헬퍼로 분리해 technical, news, options, fundamental, overall 저장 경로가 동일한 규칙을 사용하도록 한다.

### 4.3 execute 신선도

execute는 다음 순서로 기준 시각을 선택한다.

1. `source_analyzed_at`
2. 없으면 `analyzed_at`

기술 분석 최대 허용 나이는 기존 4시간이 아니라 타임프레임 기반으로 계산한다.

| 설정 | 최대 허용 나이 |
|---|---:|
| `15Min` | 45분 |
| `30Min` | 90분 |
| `1Hour` | 2시간 |

허용 나이를 넘으면 `stale_analysis`로 매매 판단을 중단한다. 네트워크 지연과 한 번의 크론 실패를 허용하기 위해 각 타임프레임의 약 2~3배 여유를 둔다.

분석 화면도 동일한 기준 시각을 사용해 오래됨 표시를 계산한다.

## 5. 미종결 크론 감사 기록

### 5.1 정리 의미

감사 행을 삭제하지 않는다. 15분 이상 `running` 상태인 행을 다음처럼 종결한다.

```text
status      = error
outcome     = timeout
finished_at = 정리 실행 시각
duration_ms = finished_at - started_at
error       = "Cron exceeded maximum execution time"
```

### 5.2 실행 위치

모든 크론 핸들러가 자신의 새 감사 행을 만들기 전에 공용 DB 함수 `finalizeStaleCronRuns`를 best-effort로 호출한다.

- 한 번의 조건부 `UPDATE`로 처리한다.
- `status = 'running' AND started_at < now() - interval '15 minutes'` 조건을 사용한다.
- 정리 실패는 현재 크론 실행을 중단하지 않고 `[cron-audit]` 오류로 기록한다.
- 여러 크론이 동시에 호출해도 첫 번째 UPDATE 이후 다른 호출은 매칭되는 행이 없어 안전하다.

`CronOutcome`에는 `timeout`을 추가한다. error 상태에서도 기계 판독 가능한 outcome을 저장할 수 있도록 `CronRunFinish` 타입과 `finishCronRun`을 확장한다.

## 6. execute 결정 감사 강화

현재 `makeTradeDecision`은 hold 사유를 생성하지만 execute의 hold 분기에서 버린다. 모든 정상 판단 결과에 다음을 기록한다.

```ts
{
  symbol,
  action: 'hold',
  score: signalScore.total,
  executed: false,
  reason: decision.reason,
  detail: {
    components: signalScore.components,
    signal: signalScore.signal,
    thresholds: { buy: buyThreshold, sell: sellThreshold },
    sourceAnalyzedAt: technicalSourceTime
  }
}
```

buy, sell, average-in 경로도 가능한 경우 같은 `components` 상세를 유지한다. 오류나 가격 누락처럼 정상 점수 결정 이전에 종료되는 경로는 기존 전용 detail을 유지한다.

## 7. 뉴스 카드 데이터 흐름 및 실행 제한

### 7.1 전체 흐름

```text
FMP 종목 뉴스
  → 최신 10건 선택
  → news_cards 일괄 조회
  → 미캐시 기사만 카드 생성
  → news_cards upsert
  → 원문 + 카드 = EnrichedNewsItem[]
  → 종목별 뉴스 종합 분석
  → analysis_results(news)
  → execute 감성 점수
```

기사별 뉴스 카드는 다음 정규화 정보를 만든다.

- 한국어 제목 및 본문 요약
- 감성
- 이벤트 카테고리
- 예상 가격 영향

기사 ID가 `news_cards.news_id`의 기본키이므로 동일 기사는 다시 저장되지 않는다. 기존 카드는 모델 호출 없이 재사용한다.

### 7.2 동시 처리

최신 기사 상한은 20개에서 10개로 줄인다. 미캐시 기사만 최대 3개 worker로 병렬 처리한다.

고정 크기 worker-pool을 사용한다. `Promise.all()`로 모든 기사를 동시에 제출하지 않는다. 각 worker는 공유 인덱스에서 다음 기사를 가져오며, 각 기사 실패는 다른 기사 결과를 무효화하지 않는다.

### 7.3 시간 예산

분석 크론 시작 시각에서 deadline을 계산해 `RunAnalysisOptions`로 전달한다.

- Vercel 제한: 800초
- 락 TTL: 780초
- 신규 작업 중단 시점: 시작 후 690초
- 종료 및 감사 저장 여유: 90초

카드 worker는 새 기사를 꺼내기 전에 deadline을 확인한다. 시간이 부족하면 신규 제출을 중단하고 지금까지 확보한 캐시 및 성공 카드만 반환한다.

종목별 뉴스 종합 분석에도 남은 시간이 부족하면 해당 종목을 `skipped` 처리한다. 한 종목이 전체 크론의 감사 종결을 막지 않도록 한다.

연속 실패 횟수만으로 전체 작업을 중단하는 기존 방식은 제거한다. 병렬 환경에서는 공유 실패 폭주를 막기 위해 전체 실패 카운터가 6건에 도달하면 신규 카드 제출을 중단한다.

## 8. siglens-core 업그레이드

`@y0ngha/siglens-core`를 `0.23.0`으로 고정해 `../siglens`와 맞춘다. 범위를 `^0.23.0`으로 두지 않아 예고 없는 분석 계약 변경을 방지한다.

업그레이드 후 다음 계약을 회귀 검증한다.

- `submitAnalysis`, `pollAnalysis`
- news card/news/options/fundamental/overall 제출 및 폴링
- `Timeframe` 타입
- 분석 응답 `analyzedAt`
- FMP `MarketDataProvider`
- 스킬 로딩 및 응답 후처리

## 9. 운영 설정 및 분석 모델 명시 저장

### 9.1 마이그레이션 기본 설정

다음 키를 `ON CONFLICT DO NOTHING`으로 삽입한다.

```json
{
  "trading_mode": "dry_run",
  "trading_enabled": true,
  "max_position_size": 5000,
  "max_total_exposure": 25000,
  "stop_loss_percent": 5,
  "take_profit_percent": 10,
  "buy_threshold": 70,
  "sell_threshold": 30,
  "analysis_timeframe": "1Hour",
  "score_weights": {
    "technical": 8,
    "news": 6,
    "options": 5,
    "fundamental": 4,
    "overall": 3
  },
  "fixed_exit_enabled": false,
  "max_trades_per_day": 20,
  "max_daily_loss_usd": 500
}
```

기존 `analysis_timeframe = '1Day'`만 `1Hour`로 변경한다. 다른 기존 운영 값은 보존한다.

### 9.2 분석 모델 설정

다음 행을 `ON CONFLICT DO NOTHING`으로 삽입한다.

| 분석 타입 | 모델 | enabled | use_byok |
|---|---|---:|---:|
| technical | gemini-2.5-flash | true | false |
| news | gemini-2.5-flash | true | false |
| options | gemini-2.5-flash | true | false |
| fundamental | gemini-2.5-flash | true | false |
| overall | gemini-2.5-flash | true | false |

기존 행은 덮어쓰지 않는다.

## 10. 마이그레이션

하나의 신규 Drizzle 마이그레이션에 다음을 포함한다.

1. `analysis_results.source_analyzed_at` 추가
2. 운영 config 누락 키 삽입
3. `analysis_timeframe='1Day'`을 `1Hour`로 변환
4. analysis model config 누락 행 삽입

마이그레이션은 재실행 안전성을 위해 `IF NOT EXISTS`와 `ON CONFLICT DO NOTHING`을 사용한다.

## 11. 오류 처리

- 분석 결과 시각 파싱 실패: 저장은 계속하고 현재 시각 또는 fallback 기준 사용
- 오래된 running 정리 실패: 현재 크론 계속 실행
- 뉴스 카드 일부 실패: 성공 및 캐시 카드로 종합 분석 진행
- 뉴스 카드 전부 실패하고 캐시 없음: 해당 종목 `skipped`
- deadline 도달: 신규 worker 제출 중단, 확보 결과만 사용
- core 업그레이드 계약 불일치: 배포하지 않고 테스트 단계에서 차단

## 12. 테스트 전략

### 설정

- API가 `15Min`, `30Min`, `1Hour`를 허용한다.
- API가 `5Min`, `4Hour`, `1Day` 및 임의 문자열을 거부한다.
- 설정 화면 기본값이 `1Hour`이고 세 선택지만 표시한다.

### 분석 시각

- 신규 결과의 `result.analyzedAt`이 `source_analyzed_at`에 저장된다.
- cached 결과도 원본 시각을 보존한다.
- 잘못된 시각은 안전하게 fallback한다.
- execute가 `source_analyzed_at`을 우선 사용한다.
- 타임프레임별 stale 경계가 적용된다.

### 감사 기록

- 15분 미만 running은 유지한다.
- 15분 이상 running은 error/timeout으로 종결한다.
- 이미 완료된 기록은 변경하지 않는다.
- 중복 호출이 안전하다.

### 결정 감사

- hold에 reason이 저장된다.
- detail에 축별 점수, 임계값, 원본 분석 시각이 저장된다.

### 뉴스 카드

- 최신 10건만 처리한다.
- 캐시 적중 기사는 제출하지 않는다.
- 동시 실행 수가 3을 넘지 않는다.
- 일부 실패 후 성공 결과를 유지한다.
- deadline 이후 신규 제출을 하지 않는다.
- 전체 실패 한도 도달 시 신규 제출을 중단한다.

### 회귀

- 전체 Vitest
- TypeScript typecheck
- ESLint
- production build
- Drizzle 마이그레이션 생성물과 스키마 일치 확인

## 13. 배포 순서

1. 코드와 마이그레이션을 같은 릴리스에 포함한다.
2. 테스트, typecheck, lint, build를 통과시킨다.
3. 프로덕션 DB 마이그레이션을 적용한다.
4. Vercel 프로덕션을 배포한다.
5. 설정 API에서 `analysis_timeframe=1Hour` 및 분석 모델 5행을 확인한다.
6. 다음 기술 크론에서 `source_analyzed_at`과 `analyzed_at`을 비교한다.
7. 다음 execute 크론에서 hold reason/detail을 확인한다.
8. 15분 이상 남아 있던 running 행이 timeout으로 종결되는지 확인한다.

## 14. 완료 기준

- 설정 UI/API/DB가 세 타임프레임만 사용한다.
- 기본 기술 분석이 1시간봉으로 실행된다.
- 동일 캐시 결과를 다시 저장해도 원본 분석 시각이 드러난다.
- execute가 오래된 원본 분석을 거래 판단에 사용하지 않는다.
- 감사 테이블에 영구 running 기록이 남지 않는다.
- 모든 hold 결정의 이유와 축별 점수를 조회할 수 있다.
- 뉴스 크론이 실행시간 여유를 남기고 종결된다.
- trader와 siglens가 siglens-core `0.23.0`을 사용한다.
- 운영 config와 분석 모델 설정이 DB에 명시적으로 존재한다.
