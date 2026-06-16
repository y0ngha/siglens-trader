# 분석 파이프라인 4종 수정 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분석 크론이 실제 결과를 저장하도록 4가지 독립 원인을 수정한다 — 옵션(yahoo v3 호환), 뉴스(카드 enrich + dedup), 분석 탭(API 계약), 펀더멘털(스케줄).

**Architecture:** A1 결정에 따라 뉴스 크론만이 카드 생산자. overall/execute는 캐시 free-ride. 신규 `news_cards` 테이블로 기사 단위 영속화 → 중복 과금 방지. ①③④는 라인 단위 수정, ②는 신규 헬퍼·테이블·시그니처 변경을 포함.

**Tech Stack:** Vercel Serverless Functions(Web Request/Response), Drizzle ORM + Neon PostgreSQL, @y0ngha/siglens-core, yahoo-finance2 v3, Vitest, MSW.

**Spec:** [`docs/specs/2026-06-16-analysis-pipeline-fixes-design.md`](../specs/2026-06-16-analysis-pipeline-fixes-design.md) (커밋 8cc85e1)

**Out of scope (스펙 §9):** `news_cards` TTL/GC, 카드 BYOK, 카드 결과 UI 노출, enrich 글로벌 deadline.

---

## File Structure

| 경로 | 변경 종류 | 책임 |
|---|---|---|
| `vitest.config.ts` | Modify | coverage.include에 신규 파일 경로 추가 (90% 게이트 적용) |
| `lib/data/yahoo-options.ts` | Modify | v3 클래스 인스턴스화 (모듈당 1회) |
| `lib/data/__tests__/yahoo-options.test.ts` | Modify | v3 mock 형태로 업데이트 + 인스턴스 1회 보장 케이스 추가 |
| `vercel.json` | Modify | 펀더멘털 cron `0 13` → `0 15` |
| `lib/db/schema.ts` | Modify | `newsCards` 테이블 추가 |
| `drizzle/0009_*.sql` | Create (자동) | `yarn db:generate` 산출물 |
| `lib/db/queries.ts` | Modify | `getNewsCards` / `upsertNewsCards` / `getAllLatestAnalysisResults` 추가 |
| `lib/db/__tests__/queries.test.ts` | Modify | 위 3개 함수 테스트 |
| `lib/analysis/types.ts` | Modify | `RunAnalysisOptions.db?: Db` 추가 |
| `lib/analysis/enrich-news-cards.ts` | Create | NewsItem[] → EnrichedNewsItem[] 변환 (단일 책임) |
| `lib/analysis/__tests__/enrich-news-cards.test.ts` | Create | 11 케이스 (happy + worst) |
| `lib/analysis/run-news.ts` | Modify | enrich 단계 통합 |
| `lib/analysis/__tests__/run-news.test.ts` | Modify | enrich 통합 케이스로 업데이트 |
| `api/cron/_run-analysis-cron.ts` | Modify | runner 호출 시 db 주입 (1줄) |
| `api/analysis.ts` | Modify | symbol 없으면 전체 조회 분기 |
| `api/__tests__/routes.test.ts` | Modify | analysis 핸들러 3 케이스 추가 |

**커밋 매핑 (스펙 §7.1):**
- 커밋 1: Task 1 (vitest config) + Task 2 (yahoo v3)
- 커밋 2: Task 3 (cron schedule)
- 커밋 3: Task 4 (news_cards 스키마/쿼리/마이그레이션)
- 커밋 4: Task 5 (enrich-news-cards)
- 커밋 5: Task 6 (run-news 통합 + RunAnalysisOptions)
- 커밋 6: Task 7 (analysis API)
- 최종: Task 8 (회귀 검증, 커밋 없음)

---

## 사전 메모

- 모든 신규/수정 파일에서 상대 import는 **`.js` 확장자 필수** ([[project-vercel-esm-import-constraint]]). 안 지키면 런타임 500.
- `@lib`/`@` alias는 src/에서만 허용. lib/ 내부에선 상대 경로만.
- 기존 모킹 패턴은 `vi.mock('module', () => ({ default: ... }))` 또는 `vi.fn()` 후 inject. yahoo-options 테스트가 좋은 레퍼런스.
- DB 테스트는 Drizzle 빌더 체인을 모킹 (`vi.mock('../index.js')`). 기존 `lib/db/__tests__/queries.test.ts` 패턴 그대로.
- 카드 생산 비용 0 단언이 가장 중요 — `expect(mockSubmitNewsCardAnalysis).toHaveBeenCalledTimes(0)` 패턴.

---

## Task 1: vitest coverage include 확장

**Files:**
- Modify: `vitest.config.ts`

**근거:** 현재 `coverage.include`가 `lib/trading/**/*.ts`만 잡고 있어 신규 파일이 90% 게이트에 잡히지 않는다. 신규/수정 파일 경로를 명시적으로 추가한다 (기존 lib/trading은 유지).

- [ ] **Step 1.1: Modify vitest.config.ts**

  파일을 열어 `coverage.include`와 `coverage.exclude`를 아래로 교체.

  ```typescript
  coverage: {
      provider: 'v8',
      include: [
          'lib/trading/**/*.ts',
          'lib/data/yahoo-options.ts',
          'lib/analysis/enrich-news-cards.ts',
          'lib/analysis/run-news.ts',
          'lib/db/queries.ts',
          'api/analysis.ts',
      ],
      exclude: [
          'lib/trading/**/*.test.ts',
          'lib/trading/types.ts',
          'lib/trading/CLAUDE.md',
          '**/__tests__/**',
      ],
      thresholds: {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
      },
  },
  ```

- [ ] **Step 1.2: Verify config syntactically valid**

  Run: `yarn typecheck`
  Expected: 통과 (vitest.config.ts는 별도 검증 필요 없음. typecheck로 충분).

- [ ] **Step 1.3: Commit (Task 2와 합쳐 커밋 1로)**

  → Task 2 완료 후 함께 커밋한다 (단일 fix 메시지로 묶음). 지금은 staging만.

---

## Task 2: ① yahoo-finance2 v3 호환

**Files:**
- Modify: `lib/data/yahoo-options.ts`
- Modify: `lib/data/__tests__/yahoo-options.test.ts`

**핵심 변경:** v3 default export가 `YahooFinance` 클래스로 바뀜. `new (...)`로 모듈 스코프 인스턴스를 만들어 재사용.

- [ ] **Step 2.1: 기존 테스트 mock을 v3 형태로 수정**

  `lib/data/__tests__/yahoo-options.test.ts` 상단의 mock 정의를 아래로 교체.

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  const mockOptions = vi.fn();
  const mockConstructor = vi.fn(() => ({ options: mockOptions }));
  vi.mock('yahoo-finance2', () => ({
      default: mockConstructor,
  }));

  describe('fetchOptionsSnapshot', () => {
      beforeEach(() => {
          mockOptions.mockReset();
          mockConstructor.mockClear();
      });

      // 기존 3 케이스(happy / fetch error / throws)는 그대로 둠.
      // 단, 두 번째·세 번째 it()의 mockRejectedValueOnce 직전에 아무 변경 없음.
  ```

- [ ] **Step 2.2: 인스턴스 1회 보장 케이스 추가**

  같은 파일 `describe` 끝(닫는 `})` 직전)에 추가:

  ```typescript
      it('인스턴스는 모듈당 1회만 생성된다', async () => {
          const { fetchOptionsSnapshot } = await import('../yahoo-options');
          mockOptions.mockResolvedValue({
              underlyingSymbol: 'AAPL',
              expirationDates: [],
              strikes: [],
              hasMiniOptions: false,
              quote: { regularMarketPrice: 100 },
              options: [],
          });
          await fetchOptionsSnapshot('AAPL');
          await fetchOptionsSnapshot('AAPL');
          await fetchOptionsSnapshot('AAPL');
          expect(mockConstructor).toHaveBeenCalledTimes(1);
      });
  ```

- [ ] **Step 2.3: 테스트 실행 — fail 확인**

  Run: `yarn test lib/data/__tests__/yahoo-options.test.ts`
  Expected: FAIL. 기존 happy 케이스가 `yahooFinance.options is not a function` 또는 `Call new YahooFinance() first`로 실패.

- [ ] **Step 2.4: 구현 — `lib/data/yahoo-options.ts` 교체**

  ```typescript
  import type { OptionsSnapshot } from '@y0ngha/siglens-core';
  import yahooFinance from 'yahoo-finance2';
  import { normalizeYahooSnapshot, type YahooOptionsResult } from './yahoo-normalize.js';

  // v3 default export는 YahooFinance 클래스. 모듈 로드 시 1회 인스턴스화하여 재사용한다.
  const yf = new (yahooFinance as unknown as new () => {
      options: (symbol: string) => Promise<unknown>;
  })();

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

- [ ] **Step 2.5: 테스트 실행 — pass 확인**

  Run: `yarn test lib/data/__tests__/yahoo-options.test.ts`
  Expected: PASS (4 케이스 전부).

- [ ] **Step 2.6: Coverage 게이트 확인 (yahoo-options.ts 단독)**

  Run: `yarn test:coverage -- lib/data/__tests__/yahoo-options.test.ts`
  Expected: yahoo-options.ts statement/branch ≥ 90%.

- [ ] **Step 2.7: Commit (Task 1 + Task 2 묶음)**

  ```bash
  git add vitest.config.ts lib/data/yahoo-options.ts lib/data/__tests__/yahoo-options.test.ts
  git commit -m "$(cat <<'EOF'
  fix(yahoo-options): v3 default export 호환을 위한 인스턴스화

  yahoo-finance2 3.x default export는 YahooFinance 클래스로 바뀌어 v2 싱글톤 호출(yahooFinance.options())이 throw하던 문제 수정. 모듈 스코프 인스턴스를 1회 생성해 재사용. coverage.include에 신규 검증 대상 경로 추가.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: ④ 펀더멘털 cron 스케줄

**Files:**
- Modify: `vercel.json`

- [ ] **Step 3.1: vercel.json 수정**

  `vercel.json`에서 fundamental 항목의 `schedule`을 변경.

  ```json
  {
      "path": "/api/cron/fundamental",
      "schedule": "0 15 * * 1-5"
  }
  ```

  나머지 5개 cron은 변경 없음.

- [ ] **Step 3.2: JSON 유효성 확인**

  Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"`
  Expected: `ok`.

- [ ] **Step 3.3: Commit**

  ```bash
  git add vercel.json
  git commit -m "$(cat <<'EOF'
  fix(cron): 펀더멘털 스케줄 0 13 → 0 15 UTC로 이동

  13:00 UTC 발화는 EDT/EST 양쪽 모두 미국 개장 전이라 isEtRegularSessionOpen 게이트에 의해 영구 스킵되던 문제 수정. 15:00 UTC는 EDT 11:00 ET, EST 10:00 ET로 양 시즌 모두 개장 후 → 매 거래일 1회 실행 보장.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: ② news_cards 테이블·쿼리·마이그레이션

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/queries.ts`
- Modify: `lib/db/__tests__/queries.test.ts`
- Create: `drizzle/0009_<name>.sql` (자동 생성)

**핵심:** 카드 dedup의 영속화 레이어. PK는 `newsId`(URL SHA-256 = `FmpNewsClient.hashUrlToId`).

- [ ] **Step 4.1: 스키마에 newsCards 추가**

  `lib/db/schema.ts` 맨 아래에 추가 (`cronDecisions` 다음).

  ```typescript
  export const newsCards = pgTable(
      'news_cards',
      {
          newsId: text('news_id').primaryKey(),
          symbol: text('symbol').notNull(),
          card: jsonb('card').notNull(),
          modelId: text('model_id').notNull(),
          createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      },
      (table) => [index('idx_news_cards_symbol_created').on(table.symbol, table.createdAt)],
  );
  ```

- [ ] **Step 4.2: Drizzle 마이그레이션 생성**

  Run: `yarn db:generate`
  Expected: `drizzle/0009_<random>.sql` 생성됨. 콘솔에 `[✓] Your SQL migration file ➜ drizzle/0009_...` 같은 출력.

- [ ] **Step 4.3: 생성된 SQL 리뷰 (수동)**

  생성된 `drizzle/0009_*.sql`를 열어 다음 확인:
  - `CREATE TABLE "news_cards"` 존재
  - `"news_id" text PRIMARY KEY NOT NULL`
  - `"card" jsonb NOT NULL`
  - `CREATE INDEX "idx_news_cards_symbol_created" ON "news_cards" ("symbol","created_at")`

  이상한 변경(다른 테이블 alter 등)이 있으면 스키마와 어긋난 것이므로 schema.ts를 다시 확인.

- [ ] **Step 4.4: queries.ts에 import 추가**

  `lib/db/queries.ts` 상단 schema import 블록에 `newsCards` 추가, `@y0ngha/siglens-core`에서 `NewsCardAnalysis` 타입 import.

  ```typescript
  import {
      watchlist,
      analysisModelConfig,
      analysisResults,
      positions,
      trades,
      pendingOrders,
      config,
      // ... 기존 항목들 그대로 ...
      cronRuns,
      cronDecisions,
      newsCards,
  } from './schema.js';
  import type { NewsCardAnalysis } from '@y0ngha/siglens-core';
  ```

- [ ] **Step 4.5: Failing 테스트 작성 (getNewsCards/upsertNewsCards)**

  `lib/db/__tests__/queries.test.ts` 끝에 `describe('news_cards')` 블록 추가. 기존 테스트의 Drizzle 빌더 mock 패턴을 따른다. (기존 파일 상단의 `vi.mock('../index.js', ...)` 패턴 그대로 재사용.)

  ```typescript
  describe('getNewsCards', () => {
      it('빈 id 배열 입력 시 빈 Map 반환 (DB 호출 없음)', async () => {
          const { getNewsCards } = await import('../queries');
          const result = await getNewsCards(mockDb as never, []);
          expect(result.size).toBe(0);
      });

      it('id 배열에 대해 inArray 조회 후 Map(id→card) 반환', async () => {
          const cardA = { sentiment: 'bullish', summaryKo: 'A', titleKo: 't', bodyKo: null, category: 'general', priceImpact: 'low' };
          const cardB = { sentiment: 'neutral', summaryKo: 'B', titleKo: 't', bodyKo: null, category: 'general', priceImpact: 'low' };
          mockSelectReturn([
              { newsId: 'a', card: cardA },
              { newsId: 'b', card: cardB },
          ]);
          const { getNewsCards } = await import('../queries');
          const result = await getNewsCards(mockDb as never, ['a', 'b', 'c']);
          expect(result.get('a')).toEqual(cardA);
          expect(result.get('b')).toEqual(cardB);
          expect(result.has('c')).toBe(false);
      });
  });

  describe('upsertNewsCards', () => {
      it('빈 배열 입력 시 no-op (insert 호출 없음)', async () => {
          const { upsertNewsCards } = await import('../queries');
          await upsertNewsCards(mockDb as never, []);
          expect(mockDb.insert).not.toHaveBeenCalled();
      });

      it('rows 전달 시 onConflictDoNothing 호출', async () => {
          const { upsertNewsCards } = await import('../queries');
          await upsertNewsCards(mockDb as never, [
              { newsId: 'x', symbol: 'NVDA', card: { sentiment: 'bullish' } as never, modelId: 'gemini-2.5-flash-lite' },
          ]);
          expect(mockDb.insert).toHaveBeenCalled();
          expect(mockOnConflictDoNothing).toHaveBeenCalled();
      });
  });
  ```

  > **주의:** 위 케이스의 `mockSelectReturn`, `mockOnConflictDoNothing`, `mockDb` 헬퍼는 기존 `queries.test.ts`에 정의된 패턴 그대로 재사용. 새로 정의하지 말 것. 기존 테스트에 그 명칭이 없으면 첫 케이스 작성 시 동일한 패턴으로 추가하고 모든 신규 케이스가 공유.

- [ ] **Step 4.6: Failing 확인**

  Run: `yarn test lib/db/__tests__/queries.test.ts -t "news_cards|getNewsCards|upsertNewsCards"`
  Expected: FAIL (`getNewsCards is not a function` 등).

- [ ] **Step 4.7: queries.ts 구현 추가**

  `lib/db/queries.ts` 끝에 추가.

  ```typescript
  export async function getNewsCards(
      db: Db,
      newsIds: string[],
  ): Promise<Map<string, NewsCardAnalysis>> {
      if (newsIds.length === 0) return new Map();
      const rows = await db
          .select({ newsId: newsCards.newsId, card: newsCards.card })
          .from(newsCards)
          .where(inArray(newsCards.newsId, newsIds));
      return new Map(rows.map((r) => [r.newsId, r.card as NewsCardAnalysis]));
  }

  export async function upsertNewsCards(
      db: Db,
      rows: { newsId: string; symbol: string; card: NewsCardAnalysis; modelId: string }[],
  ): Promise<void> {
      if (rows.length === 0) return;
      await db.insert(newsCards).values(rows).onConflictDoNothing();
  }
  ```

- [ ] **Step 4.8: pass 확인**

  Run: `yarn test lib/db/__tests__/queries.test.ts -t "news_cards|getNewsCards|upsertNewsCards"`
  Expected: PASS (4 케이스 전부).

- [ ] **Step 4.9: Commit**

  ```bash
  git add lib/db/schema.ts lib/db/queries.ts lib/db/__tests__/queries.test.ts drizzle/
  git commit -m "$(cat <<'EOF'
  feat(news-cards): news_cards 테이블·쿼리·마이그레이션 추가

  카드 dedup용 영속화 레이어. PK=newsId(URL SHA-256). getNewsCards는 빈 입력 시 DB 호출 없이 빈 Map 반환, upsertNewsCards는 onConflictDoNothing으로 동시성·중복과금 안전. siglens-core의 NewsCardAnalysis 타입을 직접 저장.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: ② enrich-news-cards 헬퍼

**Files:**
- Create: `lib/analysis/enrich-news-cards.ts`
- Create: `lib/analysis/__tests__/enrich-news-cards.test.ts`

**핵심:** 비용 hotspot. 11 케이스 worst case 전부 작성. branch coverage 100% 목표.

- [ ] **Step 5.1: Failing 테스트 작성 (모든 11 케이스)**

  `lib/analysis/__tests__/enrich-news-cards.test.ts` 신규 생성.

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import type { NewsItem, NewsCardAnalysis } from '@y0ngha/siglens-core';

  const mockSubmit = vi.fn();
  const mockPoll = vi.fn();
  vi.mock('@y0ngha/siglens-core', async () => {
      const actual = await vi.importActual<typeof import('@y0ngha/siglens-core')>(
          '@y0ngha/siglens-core',
      );
      return {
          ...actual,
          submitNewsCardAnalysis: (...args: unknown[]) => mockSubmit(...args),
          pollNewsCardAnalysis: (...args: unknown[]) => mockPoll(...args),
      };
  });

  const mockGetNewsCards = vi.fn();
  const mockUpsertNewsCards = vi.fn();
  vi.mock('../../db/queries.js', () => ({
      getNewsCards: (...args: unknown[]) => mockGetNewsCards(...args),
      upsertNewsCards: (...args: unknown[]) => mockUpsertNewsCards(...args),
  }));

  vi.mock('../poll-until-done.js', () => ({
      // pollUntilDone을 mockPoll로 직접 위임 (한 번만 호출)
      pollUntilDone: async (pollFn: (id: string) => Promise<unknown>, jobId: string) => {
          const r = (await pollFn(jobId)) as { status: string; result?: unknown; error?: string };
          if (r.status === 'done') return { result: r.result };
          return { error: r.error ?? 'unknown' };
      },
  }));

  const fakeDb = {} as never;

  function makeNews(id: string, symbol = 'NVDA'): NewsItem {
      return {
          id,
          symbol,
          source: 'site',
          url: `https://x/${id}`,
          publishedAt: '2026-06-15T00:00:00Z',
          titleEn: `title ${id}`,
          bodyEn: 'body',
      };
  }

  const card = (s: string): NewsCardAnalysis => ({
      titleKo: s,
      bodyKo: null,
      summaryKo: s,
      sentiment: 'neutral',
      category: 'general',
      priceImpact: 'low',
  });

  describe('enrichNewsCards', () => {
      beforeEach(() => {
          mockSubmit.mockReset();
          mockPoll.mockReset();
          mockGetNewsCards.mockReset();
          mockUpsertNewsCards.mockReset();
      });

      it('happy: 신규 5건 → submit+poll 5회 → upsert 1회 → EnrichedNewsItem 5건', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const news = [1, 2, 3, 4, 5].map((i) => makeNews(`n${i}`));
          const result = await enrichNewsCards(fakeDb, 'NVDA', news);
          expect(mockSubmit).toHaveBeenCalledTimes(5);
          expect(mockUpsertNewsCards).toHaveBeenCalledTimes(1);
          expect(result).toHaveLength(5);
          expect(result[0].card.summaryKo).toBe('ok');
      });

      it('이중 과금 방지: 전부 캐시 hit → submit 호출 0회', async () => {
          const cached = new Map([
              ['n1', card('c1')],
              ['n2', card('c2')],
          ]);
          mockGetNewsCards.mockResolvedValueOnce(cached);
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
          expect(mockSubmit).toHaveBeenCalledTimes(0);
          expect(mockUpsertNewsCards).not.toHaveBeenCalled();
          expect(result).toHaveLength(2);
      });

      it('부분 hit: 15 캐시 + 5 신규 → submit 5회, 결과 20건', async () => {
          const cached = new Map(Array.from({ length: 15 }, (_, i) => [`n${i}`, card(`c${i}`)] as const));
          mockGetNewsCards.mockResolvedValueOnce(cached);
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('new') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const news = Array.from({ length: 20 }, (_, i) => makeNews(`n${i}`));
          const result = await enrichNewsCards(fakeDb, 'NVDA', news);
          expect(mockSubmit).toHaveBeenCalledTimes(5);
          expect(result).toHaveLength(20);
      });

      it('상한 정확성: 100건 입력 → 21번째 기사는 어떤 경로로도 카드 생성 안 됨', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const news = Array.from({ length: 100 }, (_, i) => makeNews(`n${i}`));
          await enrichNewsCards(fakeDb, 'NVDA', news);
          // getNewsCards에 넘긴 id 개수가 정확히 20
          const ids = mockGetNewsCards.mock.calls[0][1] as string[];
          expect(ids).toHaveLength(20);
          // submit도 20회만
          expect(mockSubmit).toHaveBeenCalledTimes(20);
          // upsert에 들어간 row 수도 20
          const rows = mockUpsertNewsCards.mock.calls[0][1] as unknown[];
          expect(rows).toHaveLength(20);
      });

      it('부분 실패: 5건 중 2건 poll error → 성공 3건만 enrich/persist', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          let i = 0;
          mockPoll.mockImplementation(async () => {
              i += 1;
              if (i === 2 || i === 4) return { status: 'error', error: 'rate-limit' };
              return { status: 'done', result: card(`ok${i}`) };
          });
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const news = [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`));
          const result = await enrichNewsCards(fakeDb, 'NVDA', news);
          expect(result).toHaveLength(3);
          const persistedRows = mockUpsertNewsCards.mock.calls[0][1] as { newsId: string }[];
          expect(persistedRows).toHaveLength(3);
      });

      it('전부 실패: 5건 모두 poll error → 빈 배열 반환, upsert 호출 0회', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'error', error: 'down' }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', [1, 2, 3, 4, 5].map((n) => makeNews(`n${n}`)));
          expect(result).toEqual([]);
          expect(mockUpsertNewsCards).not.toHaveBeenCalled();
      });

      it('submit이 non-submitted (rate-limit 등) 반환 시 해당 건 드롭, 나머지 진행', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          let i = 0;
          mockSubmit.mockImplementation(async () => {
              i += 1;
              if (i === 1) return { status: 'rate_limited' };
              return { status: 'submitted', jobId: 'j' };
          });
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
          expect(result).toHaveLength(1);
      });

      it('submit이 throw 시에도 다른 카드는 진행', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          let i = 0;
          mockSubmit.mockImplementation(async () => {
              i += 1;
              if (i === 1) throw new Error('network');
              return { status: 'submitted', jobId: 'j' };
          });
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
          expect(result).toHaveLength(1);
      });

      it('upsertNewsCards가 throw 시에도 메모리 카드로 결과 반환 (5.6 완화책)', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          mockUpsertNewsCards.mockRejectedValueOnce(new Error('neon down'));
          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1'), makeNews('n2')]);
          expect(result).toHaveLength(2);
          expect(errorSpy).toHaveBeenCalled();
          errorSpy.mockRestore();
      });

      it('submit 호출 시 thinkingBudget: 0 전달', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          mockSubmit.mockImplementation(async () => ({ status: 'submitted', jobId: 'j' }));
          mockPoll.mockImplementation(async () => ({ status: 'done', result: card('ok') }));
          const { enrichNewsCards } = await import('../enrich-news-cards');
          await enrichNewsCards(fakeDb, 'NVDA', [makeNews('n1')]);
          expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ thinkingBudget: 0 }));
      });

      it('빈 news 입력 → 빈 배열, DB 호출도 빈 입력으로 1회 또는 생략', async () => {
          mockGetNewsCards.mockResolvedValueOnce(new Map());
          const { enrichNewsCards } = await import('../enrich-news-cards');
          const result = await enrichNewsCards(fakeDb, 'NVDA', []);
          expect(result).toEqual([]);
          expect(mockSubmit).not.toHaveBeenCalled();
          expect(mockUpsertNewsCards).not.toHaveBeenCalled();
      });
  });
  ```

- [ ] **Step 5.2: Failing 확인**

  Run: `yarn test lib/analysis/__tests__/enrich-news-cards.test.ts`
  Expected: FAIL (모듈 미존재 `Cannot find module '../enrich-news-cards'`).

- [ ] **Step 5.3: 구현 — `lib/analysis/enrich-news-cards.ts` 생성**

  ```typescript
  import {
      submitNewsCardAnalysis,
      pollNewsCardAnalysis,
      type NewsItem,
      type NewsCardAnalysis,
      type EnrichedNewsItem,
  } from '@y0ngha/siglens-core';
  import type { Db } from '../db/index.js';
  import { getNewsCards, upsertNewsCards } from '../db/queries.js';
  import { pollUntilDone } from './poll-until-done.js';

  export const NEWS_ENRICH_LIMIT = 20;
  export const CARD_MODEL_ID = 'gemini-2.5-flash-lite';

  export async function enrichNewsCards(
      db: Db,
      symbol: string,
      news: NewsItem[],
  ): Promise<EnrichedNewsItem[]> {
      const capped = news.slice(0, NEWS_ENRICH_LIMIT);
      const cached = await getNewsCards(db, capped.map((n) => n.id));

      const fresh: { item: NewsItem; card: NewsCardAnalysis }[] = [];
      for (const item of capped) {
          if (cached.has(item.id)) continue;
          try {
              const sub = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
              if (sub.status !== 'submitted' || !('jobId' in sub)) continue;
              const polled = await pollUntilDone(pollNewsCardAnalysis, sub.jobId);
              if ('error' in polled) {
                  console.warn('[enrich-news-cards] card failed', {
                      symbol,
                      id: item.id,
                      error: polled.error,
                  });
                  continue;
              }
              fresh.push({ item, card: polled.result as NewsCardAnalysis });
          } catch (err) {
              console.warn('[enrich-news-cards] card threw', { symbol, id: item.id, err });
          }
      }

      if (fresh.length > 0) {
          try {
              await upsertNewsCards(
                  db,
                  fresh.map((f) => ({
                      newsId: f.item.id,
                      symbol,
                      card: f.card,
                      modelId: CARD_MODEL_ID,
                  })),
              );
          } catch (err) {
              console.error(
                  '[enrich-news-cards] persist failed (proceeding with in-memory)',
                  err,
              );
          }
          for (const f of fresh) cached.set(f.item.id, f.card);
      }

      return capped
          .filter((n) => cached.has(n.id))
          .map((n) => ({ ...n, card: cached.get(n.id)! }));
  }
  ```

- [ ] **Step 5.4: pass 확인**

  Run: `yarn test lib/analysis/__tests__/enrich-news-cards.test.ts`
  Expected: PASS (11 케이스 전부).

- [ ] **Step 5.5: Coverage 게이트 확인 (branch 100% 목표)**

  Run: `yarn test:coverage -- lib/analysis/__tests__/enrich-news-cards.test.ts`
  Expected: enrich-news-cards.ts branch ≥ 95%, statements/lines/functions 100%.
  branch가 95% 미만이면 case 매트릭스 누락. 어떤 분기가 빠졌는지 보고 케이스 추가.

- [ ] **Step 5.6: Commit**

  ```bash
  git add lib/analysis/enrich-news-cards.ts lib/analysis/__tests__/enrich-news-cards.test.ts
  git commit -m "$(cat <<'EOF'
  feat(news-enrich): NewsItem → EnrichedNewsItem 변환 헬퍼

  DB dedup → submit+poll(thinkingBudget:0) → onConflictDoNothing 영속화 단일 책임. 20건 상한·부분 실패 시 성공분 진행·upsert 실패 시 메모리 카드 반환 등 worst case 11종 검증.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: ② run-news 통합 + RunAnalysisOptions 시그니처

**Files:**
- Modify: `lib/analysis/types.ts`
- Modify: `lib/analysis/run-news.ts`
- Modify: `lib/analysis/__tests__/run-news.test.ts`
- Modify: `api/cron/_run-analysis-cron.ts`

**핵심:** run-news가 db에 접근하도록 시그니처 확장. factory가 db를 주입. 다른 runner들은 옵션을 받기만 하고 무시(`db?` optional).

- [ ] **Step 6.1: RunAnalysisOptions에 db 옵션 추가**

  `lib/analysis/types.ts` 수정.

  ```typescript
  import type { ModelId, Timeframe } from '@y0ngha/siglens-core';
  import type { Db } from '../db/index.js';

  export type AnalysisType = 'technical' | 'news' | 'options' | 'fundamental' | 'overall';

  export interface RunAnalysisOptions {
      symbol: string;
      companyName: string;
      modelId: ModelId;
      userApiKey?: string;
      timeframe?: Timeframe;
      /** news enrich에 필요. factory가 항상 주입. */
      db?: Db;
  }

  export interface AnalysisRunResult {
      status: 'done' | 'cached' | 'error' | 'skipped';
      result?: unknown;
      error?: string;
  }
  ```

- [ ] **Step 6.2: factory가 db를 주입하도록 수정**

  `api/cron/_run-analysis-cron.ts` 라인 90~96 (runner 호출). `db` 한 줄 추가.

  ```typescript
  const result = await runner({
      symbol: item.symbol,
      companyName: item.companyName,
      modelId: config.modelId as RunAnalysisOptions['modelId'],
      userApiKey: config.useByok ? resolveApiKey(config.modelId) : undefined,
      timeframe: (timeframe as RunAnalysisOptions['timeframe']) ?? undefined,
      db,
  });
  ```

  다른 runner(technical/options/fundamental)는 db를 받기만 하고 무시. 호환성 유지.

- [ ] **Step 6.3: Failing 테스트 작성/업데이트 (run-news)**

  `lib/analysis/__tests__/run-news.test.ts` 수정. 기존 케이스(FMP 0건/cached/poll error 등)는 db 인자 추가만 하고 그대로 유지. enrich 통합 신규 케이스 추가:

  ```typescript
  const mockEnrichNewsCards = vi.fn();
  vi.mock('../enrich-news-cards.js', () => ({
      enrichNewsCards: (...args: unknown[]) => mockEnrichNewsCards(...args),
  }));

  // (기존 mock들 그대로 유지)

  const fakeDb = {} as never;
  const opts = (overrides: Partial<RunAnalysisOptions> = {}): RunAnalysisOptions => ({
      symbol: 'NVDA',
      companyName: 'NVIDIA',
      modelId: 'gemini-2.5-flash' as never,
      db: fakeDb,
      ...overrides,
  });

  it('happy: enrich → submitNewsAnalysis(submitted) → poll(done) → status:done', async () => {
      mockFetchNews.mockResolvedValueOnce([/* NewsItem 5건 */]);
      mockEnrichNewsCards.mockResolvedValueOnce([/* EnrichedNewsItem 5건 */]);
      mockSubmitNewsAnalysis.mockResolvedValueOnce({ status: 'submitted', jobId: 'j' });
      mockPollNewsAnalysis.mockResolvedValueOnce({ status: 'done', result: { trend: 'bullish' } });
      const { runNewsAnalysis } = await import('../run-news');
      const r = await runNewsAnalysis(opts());
      expect(r.status).toBe('done');
      expect(mockSubmitNewsAnalysis).toHaveBeenCalledWith(
          expect.objectContaining({ news: expect.any(Array) }),
      );
  });

  it('enrich 빈 결과 → status:skipped, submitNewsAnalysis 호출 0', async () => {
      mockFetchNews.mockResolvedValueOnce([/* 5건 */]);
      mockEnrichNewsCards.mockResolvedValueOnce([]);
      const { runNewsAnalysis } = await import('../run-news');
      const r = await runNewsAnalysis(opts());
      expect(r.status).toBe('skipped');
      expect(mockSubmitNewsAnalysis).not.toHaveBeenCalled();
  });
  ```

  기존 케이스(FMP 0건/submit cached/poll error/throws)는 `mockEnrichNewsCards.mockResolvedValueOnce([...적당히...])` 추가만 하면 통과.

- [ ] **Step 6.4: Failing 확인**

  Run: `yarn test lib/analysis/__tests__/run-news.test.ts`
  Expected: 기존 happy/cached/error 케이스가 `enrichNewsCards is not a function` 또는 unexpected mock 호출로 FAIL.

- [ ] **Step 6.5: 구현 — `lib/analysis/run-news.ts` 교체**

  ```typescript
  import { submitNewsAnalysis, pollNewsAnalysis } from '@y0ngha/siglens-core';
  import type { EarningsCalendarItem } from '@y0ngha/siglens-core';
  import { FmpNewsClient } from '../data/fmp-news.js';
  import { FmpFundamentalClient } from '../data/fmp-fundamental.js';
  import { pollUntilDone } from './poll-until-done.js';
  import { enrichNewsCards } from './enrich-news-cards.js';
  import type { AnalysisRunResult, RunAnalysisOptions } from './types.js';

  const newsClient = new FmpNewsClient();
  const fundamentalClient = new FmpFundamentalClient();

  export async function runNewsAnalysis(options: RunAnalysisOptions): Promise<AnalysisRunResult> {
      if (!options.db) {
          return { status: 'error', error: 'db not provided to runNewsAnalysis' };
      }
      try {
          const news = await newsClient.fetchNews(options.symbol, '7d');
          if (news.length === 0) return { status: 'skipped' };

          const enriched = await enrichNewsCards(options.db, options.symbol, news);
          if (enriched.length === 0) return { status: 'skipped' };

          const earningsReports = await fundamentalClient.getEarningsReports(options.symbol);
          const upcomingCalendar: EarningsCalendarItem[] = earningsReports.map((r) => ({
              symbol: r.symbol,
              earningsDate: r.earningsDate,
              epsActual: r.epsActual,
              epsEstimated: r.epsEstimated,
              revenueActual: r.revenueActual,
              revenueEstimated: r.revenueEstimated,
              lastUpdated: r.lastUpdated ?? new Date().toISOString(),
          }));

          const submission = await submitNewsAnalysis({
              symbol: options.symbol,
              modelId: options.modelId,
              news: enriched,
              upcomingCalendar,
              userApiKey: options.userApiKey,
          });

          if (submission.status === 'cached') {
              return { status: 'cached', result: submission.result };
          }
          if (submission.status !== 'submitted' || !('jobId' in submission)) {
              return { status: 'skipped' };
          }

          const polled = await pollUntilDone(pollNewsAnalysis, submission.jobId);
          if ('error' in polled) return { status: 'error', error: polled.error };
          return { status: 'done', result: polled.result };
      } catch (err) {
          return { status: 'error', error: String(err) };
      }
  }
  ```

- [ ] **Step 6.6: pass 확인 (run-news + factory 호환)**

  Run: `yarn test lib/analysis/__tests__/run-news.test.ts api/cron/__tests__/`
  Expected: PASS. factory 변경(`db` 인자 추가)에 회귀 없는지 동시 확인. 기존 _run-analysis-cron 테스트가 깨지면 mock에 db 인자 누락. 추가하면 통과.

- [ ] **Step 6.7: typecheck**

  Run: `yarn typecheck`
  Expected: PASS. `RunAnalysisOptions.db` 추가가 다른 runner 호출부에 영향 주지 않는지 검증.

- [ ] **Step 6.8: Coverage 게이트**

  Run: `yarn test:coverage -- lib/analysis/__tests__/run-news.test.ts`
  Expected: run-news.ts ≥ 90%.

- [ ] **Step 6.9: Commit**

  ```bash
  git add lib/analysis/types.ts lib/analysis/run-news.ts lib/analysis/__tests__/run-news.test.ts api/cron/_run-analysis-cron.ts
  git commit -m "$(cat <<'EOF'
  fix(news): runNewsAnalysis에 카드 enrich 단계 통합

  raw NewsItem[]을 EnrichedNewsItem[]으로 변환하지 못해 siglens-core의 formatNewsItem이 TypeError(item.card.sentiment)를 던지던 문제 해결. RunAnalysisOptions에 db?: Db 추가, factory가 항상 주입. enrich 결과 0건 시 skipped.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: ③ 분석 탭 빈 화면 — API 계약 수정

**Files:**
- Modify: `lib/db/queries.ts`
- Modify: `lib/db/__tests__/queries.test.ts`
- Modify: `api/analysis.ts`
- Modify: `api/__tests__/routes.test.ts`

**핵심:** `GET /api/analysis` (symbol 없음)이 `[]` 대신 `(symbol, type)`별 최신 1행을 반환.

- [ ] **Step 7.1: Failing 테스트 작성 — getAllLatestAnalysisResults**

  `lib/db/__tests__/queries.test.ts` 끝에 추가.

  ```typescript
  describe('getAllLatestAnalysisResults', () => {
      it('빈 테이블 → 빈 배열', async () => {
          mockSelectReturn([]);
          const { getAllLatestAnalysisResults } = await import('../queries');
          const result = await getAllLatestAnalysisResults(mockDb as never);
          expect(result).toEqual([]);
      });

      it('(symbol, analysis_type) 중복 시 최신 1행만 채택 (메모리 dedup)', async () => {
          // mock은 analyzedAt desc로 정렬된 raw rows를 반환. 같은 (symbol, type) 중복 포함.
          mockSelectReturn([
              { id: 12, symbol: 'NVDA', analysisType: 'technical', result: { v: 'new' }, analyzedAt: '2026-06-15T19:00:00Z' },
              { id: 11, symbol: 'NVDA', analysisType: 'news', result: {}, analyzedAt: '2026-06-15T18:00:00Z' },
              { id: 10, symbol: 'NVDA', analysisType: 'technical', result: { v: 'old' }, analyzedAt: '2026-06-15T18:00:00Z' },
          ]);
          const { getAllLatestAnalysisResults } = await import('../queries');
          const result = await getAllLatestAnalysisResults(mockDb as never);
          expect(result).toHaveLength(2);
          const technical = result.find((r: { analysisType: string }) => r.analysisType === 'technical');
          expect((technical as { result: { v: string } }).result.v).toBe('new'); // 더 최신 행
      });
  });
  ```

- [ ] **Step 7.2: Failing 확인**

  Run: `yarn test lib/db/__tests__/queries.test.ts -t "getAllLatestAnalysisResults"`
  Expected: FAIL.

- [ ] **Step 7.3: 구현 — queries.ts에 함수 추가**

  기존 `getLatestAnalysisResults`(line 149)가 builder API를 쓰므로, 일관성·타입 안전성을 위해 raw SQL 대신 builder + 메모리 dedup으로 구현. 행 수가 작아(워치리스트 4종목 × 4종 타입 = 최대 16) 부담 없음.

  ```typescript
  export async function getAllLatestAnalysisResults(db: Db) {
      // analyzedAt 내림차순으로 가져온 뒤 (symbol, analysis_type) 첫 매칭만 채택 = 최신 1행/조합.
      const rows = await db
          .select()
          .from(analysisResults)
          .orderBy(desc(analysisResults.analyzedAt));
      const seen = new Set<string>();
      const latest: typeof rows = [];
      for (const r of rows) {
          const key = `${r.symbol}:${r.analysisType}`;
          if (seen.has(key)) continue;
          seen.add(key);
          latest.push(r);
      }
      return latest;
  }
  ```

  > **주의:** 반환 타입은 기존 `getLatestAnalysisResults`와 동일하게 `analysisResults` row 형태 → 프론트 `AnalysisEntry`와 호환. `api/analysis.ts`에서 추가 매핑 불요.

- [ ] **Step 7.4: pass 확인**

  Run: `yarn test lib/db/__tests__/queries.test.ts -t "getAllLatestAnalysisResults"`
  Expected: PASS.

- [ ] **Step 7.5: Failing 테스트 — api/analysis 핸들러**

  `api/__tests__/routes.test.ts`의 analysis 섹션(없으면 신규 describe)에 추가.

  ```typescript
  describe('GET /api/analysis', () => {
      it('symbol 없으면 getAllLatestAnalysisResults 호출 → 전체 반환', async () => {
          mockGetAllLatestAnalysisResults.mockResolvedValueOnce([{ id: 1, symbol: 'NVDA', analysisType: 'technical' }]);
          const { GET } = await import('../analysis');
          const res = await GET(new Request('http://x/api/analysis'));
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body).toHaveLength(1);
          expect(mockGetAllLatestAnalysisResults).toHaveBeenCalled();
          expect(mockGetLatestAnalysisResults).not.toHaveBeenCalled();
      });

      it('symbol 있으면 getLatestAnalysisResults 호출 (기존 동작 보존)', async () => {
          mockGetLatestAnalysisResults.mockResolvedValueOnce([]);
          const { GET } = await import('../analysis');
          const res = await GET(new Request('http://x/api/analysis?symbol=NVDA'));
          expect(res.status).toBe(200);
          expect(mockGetLatestAnalysisResults).toHaveBeenCalledWith(expect.anything(), 'NVDA');
          expect(mockGetAllLatestAnalysisResults).not.toHaveBeenCalled();
      });

      it('미인증 → 403', async () => {
          mockIsAuthenticated.mockResolvedValueOnce(false);
          const { GET } = await import('../analysis');
          const res = await GET(new Request('http://x/api/analysis'));
          expect(res.status).toBe(403);
      });
  });
  ```

  > 위 mock(`mockGetAllLatestAnalysisResults`, `mockGetLatestAnalysisResults`, `mockIsAuthenticated`)는 기존 routes.test.ts의 `vi.mock('../../lib/db/queries.js', ...)` 블록에 추가/재사용. 기존 패턴 따름.

- [ ] **Step 7.6: Failing 확인**

  Run: `yarn test api/__tests__/routes.test.ts -t "GET /api/analysis"`
  Expected: FAIL (현재 코드는 symbol 없으면 `[]` 즉시 반환 → mock 호출 0).

- [ ] **Step 7.7: 구현 — `api/analysis.ts` 수정**

  ```typescript
  import { getDb } from './_lib/db.js';
  import { isAuthenticated } from './_lib/auth.js';
  import {
      getLatestAnalysisResults,
      getAllLatestAnalysisResults,
  } from '../lib/db/queries.js';

  async function handler(req: Request): Promise<Response> {
      if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
      if (req.method !== 'GET') return new Response(null, { status: 405 });

      const url = new URL(req.url, 'http://localhost');
      const symbol = url.searchParams.get('symbol');

      const db = getDb();
      const results = symbol
          ? await getLatestAnalysisResults(db, symbol)
          : await getAllLatestAnalysisResults(db);

      return Response.json(results);
  }

  export const GET = handler;
  ```

- [ ] **Step 7.8: pass 확인**

  Run: `yarn test api/__tests__/routes.test.ts -t "GET /api/analysis"`
  Expected: PASS.

- [ ] **Step 7.9: Commit**

  ```bash
  git add lib/db/queries.ts lib/db/__tests__/queries.test.ts api/analysis.ts api/__tests__/routes.test.ts
  git commit -m "$(cat <<'EOF'
  fix(analysis-api): symbol 미지정 시 전체 최신 결과 반환

  GET /api/analysis가 symbol 없으면 [] 반환하던 탓에 프론트 분석 탭이 항상 빈 화면이던 문제 수정. 새 getAllLatestAnalysisResults가 (symbol, analysis_type)별 최신 1행만 PostgreSQL DISTINCT ON으로 조회.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: 최종 회귀 검증 (코드 변경 없음)

**Files:** 없음. 전체 게이트 확인만.

- [ ] **Step 8.1: 린트**

  Run: `yarn lint`
  Expected: 0 error. warn은 기존 수준 유지(증가 없음).

- [ ] **Step 8.2: 타입체크**

  Run: `yarn typecheck`
  Expected: PASS.

- [ ] **Step 8.3: 전체 테스트 + 커버리지 게이트**

  Run: `yarn test:coverage`
  Expected: 모든 케이스 PASS. lines/statements/branches/functions ≥ 90% (Task 1에서 추가한 신규 파일들 포함).

  실패 시:
  - branch 90% 미만 → enrich-news-cards나 run-news 케이스에서 분기 누락. Section 5에서 추가
  - 다른 영역 회귀 → 해당 테스트의 mock 인자에 `db` 누락 가능성

- [ ] **Step 8.4: 빌드**

  Run: `yarn build`
  Expected: PASS. `.js` 확장자 누락이 있으면 런타임 모듈 해석은 통과하지만, 일부 ESM 환경에서 실패할 수 있다. build가 통과해야 한다.

- [ ] **Step 8.5: 커밋 시퀀스 확인**

  Run: `git log --oneline main..HEAD`
  Expected: 6개 커밋이 다음 순서로 나타남.
  ```
  fix(analysis-api): ...
  fix(news): runNewsAnalysis에 카드 enrich 단계 통합
  feat(news-enrich): ...
  feat(news-cards): ...
  fix(cron): 펀더멘털 스케줄 ...
  fix(yahoo-options): v3 default export ...
  ```

- [ ] **Step 8.6: PR 본문 체크리스트 작성 (스펙 §7.4 복사)**

  PR 본문에 아래를 그대로 포함:

  ```markdown
  ## 배포 후 검증 체크리스트
  - [ ] yarn db:migrate 성공, \d news_cards 확인
  - [ ] Vercel Cron: fundamental 0 15 * * 1-5 표시
  - [ ] 첫 news 크론: cron_runs.status='completed', summary.saved>=1
  - [ ] news_cards 행 수 > 0 (콜드 워밍업)
  - [ ] 두 번째 news 크론: submitNewsCardAnalysis 호출 0 또는 매우 적음
  - [ ] options 크론: saved>=1
  - [ ] 분석 탭: 4종목 모두 4타입 표시(펀더멘털은 첫 일일 발화 후)
  - [ ] 감사 탭: cron_decisions에 hold만이 아닌 buy/sell/avg_in 후보 등장

  ## 배포 순서 (스펙 §7.2)
  1. PR merge → main
  2. yarn release:minor (chore: release v0.6.0)
  3. Vercel 배포 완료 직후, 첫 news 크론 발화 전에 `yarn db:migrate`
  4. Vercel Cron 탭에서 fundamental 0 15 * * 1-5 반영 확인
  ```

---

## 후속 작업 (이번 범위 외, 스펙 §9)

- `news_cards` TTL/GC 야간 크론
- 카드 분석 BYOK
- 카드 결과 사용자 가시화
- enrich 글로벌 deadline (카드 전체 실패 시 maxDuration 위험 완화)
