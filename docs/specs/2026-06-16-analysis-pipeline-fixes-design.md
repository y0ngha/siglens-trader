# 분석 파이프라인 4종 수정 — 설계

작성일: 2026-06-16
대상 버전: v0.6.0 (예정)
관련 메모리: [[project-toss-openapi-live]], [[project-prod-deploy-gate-and-seed]], [[project-vercel-esm-import-constraint]], [[feedback-test-coverage-standard]]

---

## 1. 배경 — 진단 결과

크론은 외형상 동작하지만(`cron_runs`에 `completed` 기록) 실제로 분석 결과가 거의 저장되지 않고 있다. DB 직접 조회 + 실제 runner 로컬 재현으로 4가지 독립 원인을 확정했다.

### 1.1 DB 실태 (Neon 직접 조회, 2026-06-16 기준)

| 테이블 | 상태 |
|---|---|
| `analysis_results` | 21건 전부 `technical`만. news/options/fundamental 0건 |
| `cron_runs` 7일 집계 | news/options `completed` 각 6회, summary 전부 `{processed:4, saved:0}` |
| `cron_runs` fundamental | `market_closed`로 1회 스킵 후 더 이상 발화 없음 |
| `cron_decisions` | execute 전부 `hold`, reason null, 점수 기본값 — 분석 데이터 부재의 결과 |
| `trades`, `positions`, `pending_orders` | 0건 |

### 1.2 4가지 근본 원인 (모두 로컬 재현 완료)

| # | 영역 | 원인 | 재현 방식 |
|---|---|---|---|
| ① | 옵션 | `yahoo-finance2@3.14.1` v3 breaking change. default export가 `YahooFinance` 클래스로 바뀌었으나 `lib/data/yahoo-options.ts`는 v2 싱글톤 호출(`yahooFinance.options()`)을 그대로 사용 → 모든 호출 throw → `null` 반환 → runner `skipped` | `Error: Call const yahooFinance = new YahooFinance() first.` 직접 재현 |
| ② | 뉴스 | siglens-core의 `formatNewsItem`이 `item.card.sentiment` 등 `EnrichedNewsItem.card`(LLM 생성 메타) 필수 요구. `run-news.ts`는 `.card` 없는 raw `NewsItem[]`을 캐스팅하여 전달 → `TypeError: Cannot read properties of undefined (reading 'sentiment')` → runner `error` | 직접 재현. FMP 뉴스 자체는 정상(100건 수신 확인) |
| ③ | 분석 탭 빈 화면 | `src/pages/Analysis.tsx:93`이 `api.getAnalysis(undefined)` 호출. `api/analysis.ts:12`는 symbol 없으면 무조건 `[]` 반환. DB에 technical 21건이 있어도 항상 "분석 결과가 없습니다" 표시 | 코드 양쪽 확인 |
| ④ | 펀더멘털 스케줄 | `0 13 * * 1-5` (13:00 UTC) 발화는 EDT 개장 30분 전·EST 개장 1.5시간 전 → 매번 `isEtRegularSessionOpen` 게이트에 의해 `market_closed`로 스킵 → 영구 미실행. 펀더멘털 runner 자체는 정상 동작(로컬 21초 done 확인) | DB cron_runs + 로컬 runner 호출 |

### 1.3 execute(매매) 경로에 미치는 연쇄 영향

`runOverallAnalysis`(execute 경로의 신호 계산)는 동일하게 깨진 yahoo 옵션과 card 없는 raw 뉴스에 의존한다. 게다가 `submitOverallAnalysis`는 sub-axis Redis 캐시(news/options/fundamental) 미스 시 `pending_dependencies`로 떨어진다. ①②④를 고치면 execute가 함께 정상화된다.

### 1.4 비용 토글 검증

`Settings.tsx` 뉴스 ON/OFF → POST `/api/config` → `updateAnalysisConfig`(upsert) → 다음 크론 `getAnalysisConfig`가 `enabled:false` row 반환 → `_run-analysis-cron.ts`가 `outcome:'disabled'`로 스킵. 코드 체인 전체 검증 완료. **끄면 LLM 호출 0**.

---

## 2. 범위

| 포함 | 제외 |
|---|---|
| 위 ①②③④ 4개 fix | Toss 주문 체결 경로(별도 placeholder) |
| `news_cards` 테이블 신설 + Drizzle 마이그레이션 1개 | overall/execute 로직 변경 (신호 부재 시 hold는 기존 그대로) |
| 신규 테스트, 회귀 가드 | `news_cards` TTL/GC (후속) |
| 단일 PR + v0.6.0 릴리스 커밋 | 펀더멘털을 매시간 발화로 전환 (의도 위배) |

---

## 3. 아키텍처 개요

```
fix ①  lib/data/yahoo-options.ts            (1줄 수정: v3 인스턴스화)
fix ②  lib/analysis/run-news.ts             (raw → enriched 변환 단계 삽입)
       + lib/analysis/enrich-news-cards.ts  (신규: card dedup·submit·poll·persist)
       + lib/db/schema.ts                   (신규 테이블 news_cards)
       + lib/db/queries.ts                  (getNewsCards / upsertNewsCards)
       + drizzle 마이그레이션 1개
fix ③  api/analysis.ts                      (symbol 없으면 전체 반환)
       + lib/db/queries.ts                  (getAllLatestAnalysisResults)
fix ④  vercel.json                          (펀더멘털 0 13 → 0 15 UTC)
```

**불변 (변경하지 않음):**
- `_run-analysis-cron.ts` 팩토리(lock·session gate·skipped/cached 분기)
- `run-overall.ts` — A1 결정에 따라 카드 생산을 하지 않고, 뉴스 크론이 저장한 캐시를 free-ride
- 인증/감사/순서/트랜잭션 흐름
- `EnrichedNewsItem` 타입 (siglens-core 계약 그대로 따름)

**의존 방향 (CLAUDE.md 규칙 준수):**
- `lib/data/` 인프라: FMP 원시 데이터만 — 카드 분석 모름
- `lib/analysis/enrich-news-cards.ts` 신규(애플리케이션): `NewsItem[] → EnrichedNewsItem[]` 변환만 담당. 이 한 곳만 LLM 카드 호출
- `lib/db/queries.ts` 인프라: `news_cards` CRUD만
- `run-news`·`run-overall`: enrich 헬퍼 호출만(주입)
- `lib/strategy/` 무영향, `src/` → `lib/` 직접 import 없음

### 3.1 카드 생산자 결정 (A1)

**뉴스 크론 단독 생산자, overall은 읽기 전용.**

- `run-news`만 카드 생성(submit+poll) → `news_cards` 저장
- `run-overall`(execute 경로)은 카드 분석을 시도하지 않음. siglens-core가 sub-axis 캐시 미스 시 `pending_dependencies`로 우아하게 skip → execute는 다른 축(technical)으로 기존 로직대로 결정
- 결과: 모든 카드 비용이 뉴스 토글 단일 스위치로 통제됨. 뉴스 OFF → 카드 생산 0

대안(A2 양쪽 호출/A3 전용 워밍 크론) 기각 사유: A2는 OFF 토글을 우회해 비용 통제 의도 깨짐. A3는 4종목 규모에 운영 복잡도 과다.

---

## 4. 컴포넌트 상세

### 4.1 ① yahoo-finance2 v3 호환 — `lib/data/yahoo-options.ts`

```typescript
import yahooFinance from 'yahoo-finance2';

// v3에서 default export는 YahooFinance 클래스. 모듈 로드 시 1회 인스턴스화하고 재사용.
const yf = new (yahooFinance as unknown as new () => { options: (s: string) => Promise<unknown> })();

export async function fetchOptionsSnapshot(symbol: string): Promise<OptionsSnapshot | null> {
    try {
        const result = await yf.options(symbol);
        return normalizeYahooSnapshot(result as unknown as YahooOptionsResult, new Date());
    } catch (err) {
        console.warn(`[yahoo-options] failed to fetch ${symbol}:`, err);
        return null;
    }
}
```

`normalizeYahooSnapshot` 호환은 로컬에서 end-to-end 통과 확인됨(NVDA OptionsSnapshot 정상 생성).

### 4.2 ② `news_cards` 테이블 — `lib/db/schema.ts`

```typescript
export const newsCards = pgTable('news_cards', {
    newsId: text('news_id').primaryKey(),        // FmpNewsClient.hashUrlToId() — 안정 SHA-256
    symbol: text('symbol').notNull(),
    card: jsonb('card').notNull(),               // NewsCardAnalysis (titleKo/bodyKo/summaryKo/sentiment/category/priceImpact)
    modelId: text('model_id').notNull(),         // 'gemini-2.5-flash-lite' 고정 (스키마 변경 추적용)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('idx_news_cards_symbol_created').on(table.symbol, table.createdAt),
]);
```

- `newsId` PK = URL의 SHA-256 → 동일 기사는 어디서 들어와도 1행. 중복 과금 방지의 1차 방어
- TTL/cleanup은 1차 범위 제외. 4종목 × 신규기사만 누적이라 누적 속도 미미

### 4.3 ② 쿼리 헬퍼 — `lib/db/queries.ts`

```typescript
getNewsCards(db: Db, newsIds: string[]): Promise<Map<string, NewsCardAnalysis>>
upsertNewsCards(db: Db, rows: { newsId: string; symbol: string; card: NewsCardAnalysis; modelId: string }[]): Promise<void>
//   onConflictDoNothing — 동시성 안전, 중복 비용 방지
//   빈 배열 입력 시 no-op
```

### 4.4 ② 카드 enrich 헬퍼 — `lib/analysis/enrich-news-cards.ts` (신규)

```typescript
export const NEWS_ENRICH_LIMIT = 20;
export const CARD_MODEL_ID = 'gemini-2.5-flash-lite';

export async function enrichNewsCards(
    db: Db,
    symbol: string,
    news: NewsItem[],
): Promise<EnrichedNewsItem[]> {
    // 1. 최신 20건만 (FMP는 이미 최신순; slice로 상한 적용)
    const capped = news.slice(0, NEWS_ENRICH_LIMIT);

    // 2. DB에서 기존 카드 일괄 조회 (1 쿼리)
    const cached = await getNewsCards(db, capped.map(n => n.id));

    // 3. 미적중분만 카드 제출 (순차 — 비용·동시성 안전, 4종목×~20건이면 무시 가능 지연)
    const fresh: { item: NewsItem; card: NewsCardAnalysis }[] = [];
    for (const item of capped) {
        if (cached.has(item.id)) continue;
        try {
            const sub = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
            if (sub.status !== 'submitted') continue;
            const polled = await pollUntilDone(pollNewsCardAnalysis, sub.jobId);
            if ('error' in polled) {
                console.warn('[enrich-news-cards] card failed', { symbol, id: item.id, error: polled.error });
                continue; // 부분 실패 허용 (성공 카드로 진행)
            }
            fresh.push({ item, card: polled.result });
        } catch (err) {
            console.warn('[enrich-news-cards] card threw', { symbol, id: item.id, err });
        }
    }

    // 4. 신규 카드 영속화. 실패해도 메모리 결과는 보존(Section 5.4 완화책)
    if (fresh.length > 0) {
        try {
            await upsertNewsCards(db, fresh.map(f => ({
                newsId: f.item.id, symbol, card: f.card, modelId: CARD_MODEL_ID,
            })));
        } catch (err) {
            console.error('[enrich-news-cards] persist failed (proceeding with in-memory)', err);
        }
        for (const f of fresh) cached.set(f.item.id, f.card);
    }

    // 5. 카드 있는 것만 EnrichedNewsItem으로 묶어 반환 (없는 건 드롭)
    return capped
        .filter(n => cached.has(n.id))
        .map(n => ({ ...n, card: cached.get(n.id)! }));
}
```

설계 결정:
- `thinkingBudget: 0` — siglens-core 권장(번역/감성엔 chain-of-thought 불필요, 비용·지연 절감)
- 부분 실패 정책: 성공분만으로 진행. 0건이면 호출자가 `skipped`
- 카드 호출은 종목 내 **순차**. 병렬화는 워커 부하·rate-limit·동일 newsId 중복 제출 위험. 4×20=80 카드 순차도 800s maxDuration 안에 여유

### 4.5 ② runner 통합 — `lib/analysis/run-news.ts`

```typescript
// 변경 전 (깨진 코드):
news: news as unknown as EnrichedNewsItem[],

// 변경 후:
const enriched = await enrichNewsCards(db, options.symbol, news);
if (enriched.length === 0) return { status: 'skipped' };
// ... submitNewsAnalysis({ news: enriched, ... })
```

- `RunAnalysisOptions`에 `db: Db` 추가, `_run-analysis-cron.ts`의 runner 호출부에서 `db` 전달
- `run-overall.ts`는 **변경 없음**

### 4.6 ③ 분석 탭 빈 화면

**API — `api/analysis.ts`:**
```typescript
const symbol = url.searchParams.get('symbol');
const results = symbol
    ? await getLatestAnalysisResults(db, symbol)
    : await getAllLatestAnalysisResults(db);
return Response.json(results);
```

**신규 쿼리 — `getAllLatestAnalysisResults(db)`:** `analysis_results`에서 `(symbol, analysis_type)`별 최신 1행만 반환 (PostgreSQL `DISTINCT ON`). 응답 형태는 기존 `getLatestAnalysisResults`와 동일 `AnalysisEntry[]`로, 프론트 수정 불필요.

### 4.7 ④ 펀더멘털 크론 스케줄 — `vercel.json`

`0 13 * * 1-5` → **`0 15 * * 1-5`**

근거 (UTC, 게이트는 미국 동부 정규장 기준):

| 시즌 | 개장 (UTC) | `0 13` | `0 14` | `0 15` (선택) |
|---|---|---|---|---|
| EDT | 13:30~20:00 | 개장 전 → skip | 개장 후 → run | 개장 후 → run |
| EST | 14:30~21:00 | 개장 전 → skip | 개장 전 → skip | 개장 후 → run |

`0 15`는 연중 매 거래일 1회 실행 보장. 게이트는 휴장일(Thanksgiving 등)만 컷.

게이트와 스케줄의 역할 구분:
- **게이트(`isEtRegularSessionOpen`)**: 이미 모든 크론에 적용됨. 잘못된 시간 발화 시 LLM/API 호출 0으로 즉시 컷 → 안전망
- **스케줄**: "하루에 어느 UTC 시각을 시도할지" 결정. 펀더멘털은 일 1회 설계라 그 시각이 in-session이어야 실행됨

대안 기각:
- 매시간 발화(`0 13-21`): 펀더멘털 데이터는 분기 단위 갱신이라 매시간 호출은 순수 낭비
- `0 14`: EDT만 작동, EST 시즌 4~5개월 미실행

---

## 5. 데이터 흐름 + 동시성·실패 모드

### 5.1 정상 흐름 — 뉴스 크론 1회 (4종목)

```
13-21 UTC 매시 → news 크론 발화
  → verifyCronSecret → startCronRun(running)
  → isEtRegularSessionOpen? → no면 skipped/market_closed로 종료
  → acquireLock('cron:news:lock', 780s) → 실패면 skipped/locked
  → getAnalysisConfig('news') → enabled=false면 skipped/disabled  ← 비용 킬스위치
  → for each watchlist symbol:
       FmpNewsClient.fetchNews(symbol, '7d')      // 최대 100건
       enrichNewsCards(db, symbol, news)          // ← 신규 단계
         ├─ slice(0,20)
         ├─ getNewsCards(db, ids)                 // DB 일괄 조회
         ├─ for 미적중 카드: submit+poll (순차)
         ├─ upsertNewsCards(db, fresh)            // onConflictDoNothing
         └─ return EnrichedNewsItem[] (성공분만)
       enriched.length===0 → status:'skipped'
       그 외 → submitNewsAnalysis({news:enriched,...}) → poll → status:'done'|'cached'
       'done'/'cached'면 saveAnalysisResult()
  → finishCronRun(completed, summary:{processed:4, saved:N})
  → releaseLock()
```

### 5.2 과금 모델

- 1회차(콜드): 4종목 × ~20카드 = ~80 flash-lite 호출 + 4 flash(집계)
- 2회차+: 신규 기사만(보통 종목당 0~3건) + 4 flash. **정상 상태 비용 미미**
- 뉴스 OFF: 카드 호출 0, 집계 호출 0

### 5.3 overall 흐름 — 변경 없음

`runOverallAnalysis`가 `submitOverallAnalysis` 호출 → sub-axis Redis 캐시 검사 → hit 시 사용, miss 시 `pending_dependencies` → `skipped` 반환. execute는 점수 부재 시 hold(기존 로직).

### 5.4 동시성/락

- **뉴스 크론 락** `cron:news:lock` (780s) — 동일 cron 중첩 방지(기존)
- **DB 동시성**: `news_cards` 쓰기 충돌은 `onConflictDoNothing`으로 흡수. PK가 newsId(단일행)
- **이중 과금 가능?** 동일 newsId를 두 cron 인스턴스가 동시 호출해야 하나 락이 막음 → 불가
- **카드 호출 순서**: 종목 내 순차(`for...of await`). 4×20=80 카드 순차는 800s 내 여유

### 5.5 실패 모드 매트릭스

| 실패 지점 | 동작 | 비용 영향 | 사용자 가시성 |
|---|---|---|---|
| `fetchNews` throw (FMP 다운) | runner catch → `status:'error'` | 카드 호출 전, 0 | summary `saved:0` |
| 카드 1건 실패(LLM 에러/타임아웃) | warn + 해당 카드 드롭, 다음 진행 | 실패분만 손실 | 다음 회차 자동 재시도 |
| 카드 20건 전부 실패 | 빈 배열 반환 → runner `skipped` | 카드 호출 비용 발생(재시도 없음) | summary `saved:0`, 다음 회차 재시도 |
| `submitNewsAnalysis` throw | runner catch → `status:'error'` | 카드 비용은 이미 영속화 → 재낭비 없음 | summary error |
| `pollNewsAnalysis` 타임아웃 | `pollUntilDone` → `status:'error'` | 동일 | 동일 |
| **`upsertNewsCards` throw** | error 로그 + 메모리 카드는 반환(집계 분석 진행) | 카드 1회분 손실(다음 회차 재호출) | summary 정상, error 로그 |
| yahoo v3 추가 breaking change | options runner catch → null → submitOverallAnalysis가 옵션 없이 처리(이전과 동일) | 0 | console.warn |
| 분석 탭 API 에러 | 프론트 `ErrorMessage` 표시(기존) | - | 기존 동작 |

### 5.6 비용 hot-spot 완화 결정

"카드 호출 후 DB 저장 실패" 케이스에서, enrich는 throw하지 않고 **메모리 카드를 그대로 반환**한다(Section 4.4의 4단계 catch). 근거: 그 회차의 집계 분석을 살려야 사용자 가시성이 회복되고, 비용은 카드 1회분만 손실(다음 회차에 재호출). 점진적 upsert는 코드 복잡도 대비 이득이 작아 채택하지 않는다.

---

## 6. 테스트 전략

기준: 메모리 [[feedback-test-coverage-standard]] — 커버리지 90% 이상, happy + worst case 필수.

### 6.1 강제 worst case (이번 PR 컨텍스트)

1. **이중 과금 방지** — DB cache hit 시 `submitNewsCardAnalysis` 호출 카운트 0 단언
2. **돈 쓰고 저장 실패** — `upsertNewsCards` throw 시 메모리 카드 반환 + 로그 (5.6 완화책 검증)
3. **부분 실패 정책** — 5건 중 2건 실패해도 3건으로 진행
4. **상한 정확성** — 21번째 기사가 어떤 경로로도 카드 생성되지 않음
5. **부분 실패 후 재시도** — 실패한 newsId는 다음 회차 시뮬레이션에서 다시 submit 됨(영속화 안 됐으므로). 이건 의도 동작이고 테스트로 문서화

### 6.2 파일별 케이스 (총 29 케이스)

| 파일 | 케이스 수 | 주요 케이스 |
|---|---|---|
| `lib/data/__tests__/yahoo-options.test.ts` (업데이트) | 3 | happy / throw 시 null+warn / 모듈당 인스턴스 1개 보장 |
| `lib/analysis/__tests__/enrich-news-cards.test.ts` (신규) | 11 | 신규 5건 / 전부 캐시 hit(호출 0) / 부분 hit / 20건 상한 / 부분 실패(2건 error) / 전부 실패 / submit non-submitted / upsert throw / `thinkingBudget:0` 인자 / 동일 newsId 동시성 / 빈 입력 |
| `lib/analysis/__tests__/run-news.test.ts` (업데이트) | 6 | enrich 통합 happy / enrich 빈 결과 → skipped / FMP 0건 → skipped / submit cached / poll error / 종목 throw 격리 |
| `lib/db/__tests__/queries.test.ts` (추가) | 6 | `getNewsCards` happy+빈입력 / `upsertNewsCards` happy+conflict+빈입력 / `getAllLatestAnalysisResults` DISTINCT ON 동작 + 빈 테이블 |
| `api/__tests__/routes.test.ts` (analysis 핸들러 추가) | 3 | symbol 없음 → 전체 / symbol 있음 → 기존 / 미인증 403 |

### 6.3 커버리지 게이트

- `yarn test:coverage` 통과(전역 90%+)
- `enrich-news-cards.ts`는 비용 hotspot이므로 **branch 100% 목표**(모든 if/catch 경로)
- PR 본문에 신규 파일 statement/branch 커버리지 캡처 첨부

### 6.4 마이그레이션·크론 변경 검증 (수동)

- `yarn db:generate` 결과 SQL diff 리뷰
- 로컬 `\d news_cards`로 PK·인덱스 확인
- Vercel 대시보드 Cron 탭에서 `0 15 * * 1-5` 반영 확인

### 6.5 자동화 외 e2e (배포 후 수동)

1. 로컬 `npx tsx`로 `runNewsAnalysis({symbol:'NVDA',...})` 1회 → `news_cards` 행 생성, `analysis_results` +1 확인
2. 즉시 재실행 → `submitNewsCardAnalysis` 호출 0
3. 옵션도 동일 방식으로 1회 검증
4. 배포 후 장중 첫 크론: `cron_runs.summary.saved` ≥ 1, 분석 탭에 4종목 × 4타입 신호 표시

---

## 7. 마이그레이션·배포·롤백

### 7.1 PR 구성 — 단일 PR / 6 커밋

```
1. fix(yahoo-options): v3 호환을 위한 인스턴스화 (+테스트)            ← fix ①
2. fix(cron): 펀더멘털 스케줄 0 13 → 0 15 UTC로 이동                  ← fix ④
3. feat(news-cards): news_cards 테이블·쿼리·마이그레이션              ← ② 인프라
4. feat(news-enrich): 카드 dedup·submit·poll·영속화 헬퍼 (+테스트)    ← ② 애플리케이션
5. fix(news): runNewsAnalysis에 enrich 단계 통합 (+테스트)             ← ② 결합
6. fix(analysis-api): symbol 미지정 시 전체 최신 반환 (+테스트)        ← fix ③
```

각 커밋 독립 빌드·타입체크 통과. 5번 후에야 news 크론 정상 동작.

### 7.2 배포 순서

[[project-prod-deploy-gate-and-seed]] — Vercel은 `chore: release` 커밋에서만 배포.

```
1. PR merge → main
2. yarn release:minor (chore: release v0.6.0 커밋 트리거)
3. Vercel 배포 완료 직후, 첫 news 크론 발화 전에 yarn db:migrate 실행
   ─ 순서가 뒤집히면 첫 발화가 'news_cards 미존재' 에러로 죽음
   ─ 시간 여유: chore release 머지 → 다음 정시(13-21 UTC) 사이 일반적으로 수십 분 이상
4. Vercel Cron 탭에서 fundamental 0 15 * * 1-5 반영 확인
5. 다음 정규장 첫 news/options 크론 발화 모니터링
6. 24h 관찰 후 안정 확인
```

### 7.3 마이그레이션 안전성

- `news_cards`는 신규 테이블 — 기존 데이터 무영향, 다운타임 0
- 롤백 시 테이블은 남겨두어도 안전(다른 코드가 참조 안 함)
- Drizzle 생성 SQL은 PR에서 수동 리뷰

### 7.4 배포 후 검증 체크리스트 (PR 본문 포함)

```
[ ] yarn db:migrate 성공, \d news_cards 확인
[ ] Vercel Cron: fundamental 0 15 * * 1-5 표시
[ ] 첫 news 크론: cron_runs.status='completed', summary.saved>=1
[ ] news_cards 행 수 > 0 (콜드 워밍업)
[ ] 두 번째 news 크론: submitNewsCardAnalysis 호출 0 또는 매우 적음
[ ] options 크론: saved>=1
[ ] 분석 탭: 4종목 모두 4타입 표시(펀더멘털은 첫 일일 발화 후)
[ ] 감사 탭: cron_decisions에 hold만이 아닌 buy/sell/avg_in 후보 등장(overall 정상)
```

### 7.5 롤백 시나리오

| 문제 | 롤백 액션 | 영향 |
|---|---|---|
| 옵션이 여전히 실패 | yahoo-options.ts만 revert | 다른 fix 유지 |
| 뉴스 비용 폭발 | 설정에서 news OFF(즉시). 영구 해결은 enrich-news-cards revert | 뉴스만 정지 |
| 카드 데이터 손상 | `TRUNCATE news_cards` (다음 회차 자동 재워밍) | 일시 비용↑, 기능 회복 |
| 분석 탭 빈 응답 | api/analysis.ts revert | DB·크론 무영향 |
| 펀더멘털 스케줄 문제 | vercel.json revert | 즉시 반영 |

---

## 8. 비기능 요건

- 모든 신규 파일 상대 import에 `.js` 확장자 — [[project-vercel-esm-import-constraint]]
- `@lib`/`@` alias 금지 — 위와 동일
- `lib/db/` `lib/data/` `lib/analysis/` 경계 유지 — `lib/strategy/` 무영향
- 로그 prefix `[enrich-news-cards]`로 grep 용이
- `news_cards.modelId`는 `'gemini-2.5-flash-lite'` 하드코딩(siglens-core 내부 고정과 일치)

---

## 9. Open questions / 후속 작업 (이번 범위 외)

- `news_cards` TTL/GC (일별 cleanup 크론)
- 카드 모델 BYOK 지원 (현재는 워커 기본키 사용)
- 카드 분석 결과의 사용자 가시화 (대시보드 노출)
- 펀더멘털 결과를 execute가 같은 날 활용하는 캐시 보장(현재 hour-cron 간 캐시 의존)
- 카드 분석 전체 실패 시(예: LLM 전반 장애로 80건 모두 poll 타임아웃) 800s maxDuration 초과 위험. 현재 설계는 각 카드를 순차 poll만 하므로 worst case 누적 지연 가능. 후속 PR에서 enrich 레벨 글로벌 deadline 또는 첫 N건 연속 실패 시 short-circuit 추가 고려
