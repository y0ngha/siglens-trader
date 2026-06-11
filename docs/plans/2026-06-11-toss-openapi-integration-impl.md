# 토스증권 Open API 실연동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** placeholder인 `lib/trading/`를 토스증권 Open API 실제 스펙(OAuth2 토큰 인증 + 비동기 주문 + 안전장치)으로 재구현하고, 호출부(execute/approve/reconcile)를 비동기 체결 모델에 맞게 전환한다.

**Architecture:** `lib/trading/`를 단일 책임 모듈로 분해(token/client/account/orders). 파사드(`executeBuyOrder`/`executeSellOrder`)가 주문 접수 + 인라인 폴링 + 결과 정규화(`OrderOutcome`)를 캡슐화해 호출부 변경을 최소화한다. OAuth2 토큰은 Redis 캐싱 + 재발급 분산 락으로 관리한다.

**Tech Stack:** TypeScript, Vitest(+@vitest/coverage-v8), Drizzle ORM(Neon), Upstash Redis, Vercel Serverless.

**설계 문서:** `docs/specs/2026-06-11-toss-openapi-integration-design.md`

**테스트 기준(필수):** 모든 신규 `lib/trading/` 모듈은 **커버리지 90% 이상**. 각 모듈은 happy path + worst case(에러 응답·타임아웃·빈 응답·경계값·락 실패·부분 체결 등)를 모두 포함한다.

---

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|------|------|-----------|
| `lib/trading/types.ts` | 도메인 타입 (`OrderOutcome`, `OrderDetail`, `TossHolding`, enum, 요청 타입) | 수정(전면 교체) |
| `lib/trading/token.ts` | OAuth2 토큰 발급/캐싱/재발급 락 | 신규 |
| `lib/trading/client.ts` | 공통 fetch(토큰 주입·계좌 헤더·envelope 언랩·에러 파싱·재시도), `TossApiError`, `resolveAccountSeq` | 신규 |
| `lib/trading/account.ts` | `getHoldings`/`getBuyingPower`/`getSellableQuantity`/`cancelOrder` | 신규 |
| `lib/trading/orders.ts` | `issueOrder`/`getOrder`/`executeBuyOrder`/`executeSellOrder`(파사드+폴링) | 신규(기존 toss-client.ts/order.ts 대체) |
| `lib/trading/toss-client.ts` | (삭제) | 삭제 |
| `lib/trading/order.ts` | (삭제 → orders.ts로 흡수) | 삭제 |
| `lib/trading/__tests__/*.test.ts` | 모듈별 단위 테스트 | 신규(기존 toss-client.test.ts 대체) |
| `lib/db/schema.ts` | `order_tracking.client_order_id` 컬럼 추가 | 수정 |
| `lib/db/queries.ts` | `createOrderTracking`/`updateOrderTracking`에 `clientOrderId` 지원 | 수정 |
| `api/cron/execute.ts` | `OrderOutcome` 매핑 + 안전장치 가드 | 수정 |
| `api/cron/reconcile.ts` | `getOrder` 폴링 + `cancelOrder` + holdings 정합성 | 수정 |
| `api/approve/[id].ts` | `OrderOutcome` 매핑 | 수정 |
| `vitest.config.ts` | 커버리지 프로바이더 + lib/trading 90% 임계값 | 수정 |
| `lib/trading/CLAUDE.md` | placeholder 문구 제거, 실제 스펙 반영 | 수정 |
| `.env.example` | `TOSS_ACCOUNT_NO` 제거 | 수정 |

---

## Phase 0 — 커버리지 게이트 준비

### Task 0: 커버리지 프로바이더 설치 및 임계값 설정

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json` (devDependency)

- [ ] **Step 1: 커버리지 프로바이더 설치**

Run: `yarn add -D @vitest/coverage-v8`
Expected: `package.json` devDependencies에 `@vitest/coverage-v8` 추가.

- [ ] **Step 2: vitest.config.ts에 커버리지 임계값 추가**

`test` 블록에 `coverage` 설정 추가:

```typescript
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/__tests__/setup.ts'],
        coverage: {
            provider: 'v8',
            include: ['lib/trading/**/*.ts'],
            exclude: ['lib/trading/**/*.test.ts', 'lib/trading/types.ts', 'lib/trading/CLAUDE.md'],
            thresholds: {
                lines: 90,
                functions: 90,
                branches: 90,
                statements: 90,
            },
        },
    },
```

- [ ] **Step 3: 커버리지 실행 확인 (아직 0% — 게이트 동작 확인용)**

Run: `yarn test:coverage --run lib/trading`
Expected: 커버리지 리포트가 출력되고, 임계값 미달 시 실패. (이 시점엔 모듈이 비어 실패할 수 있음 — 게이트가 켜졌는지만 확인.)

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts package.json yarn.lock
git commit -m "test: lib/trading 커버리지 90% 임계값 게이트 추가"
```

---

## Phase 1 — 타입 정의

### Task 1: types.ts 전면 교체

**Files:**
- Modify: `lib/trading/types.ts`

- [ ] **Step 1: 신규 타입 작성**

기존 내용을 전부 삭제하고 아래로 교체:

```typescript
// 주문 방향/유형 (요청)
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

// 토스 주문 상태 (응답) — unknown code 허용 위해 string 유니온 + (string & {})
export type TossOrderStatus =
    | 'PENDING'
    | 'PENDING_CANCEL'
    | 'PENDING_REPLACE'
    | 'PARTIAL_FILLED'
    | 'FILLED'
    | 'CANCELED'
    | 'REJECTED'
    | 'CANCEL_REJECTED'
    | 'REPLACE_REJECTED'
    | 'REPLACED';

// issueOrder 입력 (저수준)
export interface IssueOrderRequest {
    symbol: string;
    side: OrderSide;
    orderType: 'MARKET'; // 본 시스템은 시장가 정수 수량만 사용
    quantity: number;
    clientOrderId: string;
}

// 파사드 반환 — 인라인 폴링까지 끝낸 정규화 결과
export interface OrderOutcome {
    orderId: string;
    clientOrderId: string;
    status: 'filled' | 'partial' | 'pending' | 'rejected' | 'canceled';
    filledQuantity?: number;
    avgFilledPrice?: number;
    rejectReason?: string;
}

// 저수준 — reconcile/폴링용 (API Order 정규화)
export interface OrderDetail {
    orderId: string;
    status: TossOrderStatus;
    filledQuantity: number;
    avgFilledPrice: number | null;
    canceledAt: string | null;
}

// HoldingsItem 정규화 (string → number)
export interface TossHolding {
    symbol: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    pnl: number;
    marketCountry: string;
    currency: string;
}

// OAuth2 토큰 응답 (표준 형식)
export interface OAuth2TokenResponse {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
}
```

- [ ] **Step 2: 타입체크**

Run: `yarn typecheck`
Expected: 기존 `toss-client.ts`/`order.ts`가 삭제된 타입(`TossOrderRequest` 등)을 참조해 에러 발생 — 다음 태스크에서 해당 파일들을 교체하므로 **이 시점의 에러는 예상됨**. 새 types.ts 자체에 문법 에러가 없는지만 확인.

- [ ] **Step 3: Commit**

```bash
git add lib/trading/types.ts
git commit -m "feat(trading): 실제 스펙 기반 도메인 타입 정의"
```

---

## Phase 2 — 토큰 매니저

### Task 2: token.ts — OAuth2 토큰 발급/캐싱/재발급 락

**Files:**
- Create: `lib/trading/token.ts`
- Test: `lib/trading/__tests__/token.test.ts`

토큰은 `client.ts`보다 하위라 `fetch`를 직접 호출한다. Redis는 `lib/lock.ts`와 동일하게 `@upstash/redis`로 직접 접근하되, 캐시용 별도 헬퍼를 둔다.

- [ ] **Step 1: 실패 테스트 작성**

`lib/trading/__tests__/token.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Redis 모킹
const redisStore = new Map<string, string>();
const mockGet = vi.fn(async (k: string) => redisStore.get(k) ?? null);
const mockSet = vi.fn(async (k: string, v: string) => {
    redisStore.set(k, v);
    return 'OK';
});
vi.mock('@upstash/redis', () => ({
    Redis: vi.fn(() => ({ get: mockGet, set: mockSet, eval: vi.fn(async () => 1) })),
}));

function tokenResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        json: () => Promise.resolve(body),
    } as Response;
}

describe('token manager', () => {
    beforeEach(() => {
        vi.resetModules();
        redisStore.clear();
        mockFetch.mockReset();
        mockGet.mockClear();
        mockSet.mockClear();
        vi.stubEnv('TOSS_APP_KEY', 'c_test');
        vi.stubEnv('TOSS_SECRET_KEY', 's_test');
        vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('발급 성공 시 access_token 반환 + form-urlencoded 전송', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 86400 }),
        );
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();

        expect(token).toBe('tok-1');
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe('https://openapi.tossinvest.com/oauth2/token');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(opts.body).toContain('grant_type=client_credentials');
        expect(opts.body).toContain('client_id=c_test');
        expect(opts.body).toContain('client_secret=s_test');
    });

    it('Redis 캐시 히트 시 재발급하지 않음', async () => {
        redisStore.set('toss:oauth:token', 'cached-tok');
        const { getAccessToken } = await import('../token');
        const token = await getAccessToken();
        expect(token).toBe('cached-tok');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('발급 후 만료 여유(60s) 차감한 TTL로 캐싱', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'tok-2', token_type: 'Bearer', expires_in: 86400 }),
        );
        const { getAccessToken } = await import('../token');
        await getAccessToken();
        expect(mockSet).toHaveBeenCalledWith(
            'toss:oauth:token',
            'tok-2',
            expect.objectContaining({ ex: 86340 }),
        );
    });

    it('worst: 401 invalid_client 응답 시 에러 throw', async () => {
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ error: 'invalid_client', error_description: 'fail' }, 401),
        );
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow(/invalid_client/);
    });

    it('worst: 네트워크 실패 전파', async () => {
        mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow('fetch failed');
    });

    it('forceRefreshToken은 캐시 무시하고 재발급', async () => {
        redisStore.set('toss:oauth:token', 'old-tok');
        mockFetch.mockResolvedValueOnce(
            tokenResponse({ access_token: 'new-tok', token_type: 'Bearer', expires_in: 100 }),
        );
        const { forceRefreshToken } = await import('../token');
        const token = await forceRefreshToken();
        expect(token).toBe('new-tok');
        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('worst: Redis 미설정(dev)이면 매번 직접 발급', async () => {
        vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
        vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
        mockFetch.mockResolvedValue(
            tokenResponse({ access_token: 'dev-tok', token_type: 'Bearer', expires_in: 100 }),
        );
        const { getAccessToken } = await import('../token');
        expect(await getAccessToken()).toBe('dev-tok');
    });

    it('worst: 자격증명 누락 시 에러', async () => {
        vi.stubEnv('TOSS_APP_KEY', '');
        const { getAccessToken } = await import('../token');
        await expect(getAccessToken()).rejects.toThrow(/TOSS_APP_KEY/);
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `yarn test --run lib/trading/__tests__/token.test.ts`
Expected: FAIL — `Cannot find module '../token'`.

- [ ] **Step 3: token.ts 구현**

```typescript
import { acquireLock, releaseLock } from '../lock';
import { Redis } from '@upstash/redis';
import type { OAuth2TokenResponse } from './types';

const TOKEN_URL = 'https://openapi.tossinvest.com/oauth2/token';
const REDIS_TOKEN_KEY = 'toss:oauth:token';
const REFRESH_LOCK_KEY = 'toss:oauth:refresh';
const EXPIRY_MARGIN_S = 60;
const LOCK_WAIT_RETRIES = 10;
const LOCK_WAIT_MS = 200;

let redis: Redis | null = null;
function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

async function issueToken(): Promise<{ token: string; ttl: number }> {
    const clientId = process.env.TOSS_APP_KEY;
    const clientSecret = process.env.TOSS_SECRET_KEY;
    if (!clientId || !clientSecret) {
        throw new Error('TOSS_APP_KEY and TOSS_SECRET_KEY are required');
    }
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Toss OAuth2 token issue failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as OAuth2TokenResponse;
    return { token: json.access_token, ttl: Math.max(1, json.expires_in - EXPIRY_MARGIN_S) };
}

async function cacheToken(token: string, ttl: number): Promise<void> {
    const r = getRedis();
    if (r) await r.set(REDIS_TOKEN_KEY, token, { ex: ttl });
}

export async function forceRefreshToken(): Promise<string> {
    const { token, ttl } = await issueToken();
    await cacheToken(token, ttl);
    return token;
}

export async function getAccessToken(): Promise<string> {
    const r = getRedis();
    if (r) {
        const cached = await r.get<string>(REDIS_TOKEN_KEY);
        if (cached) return cached;
    } else {
        // dev: Redis 없음 → 매번 발급
        const { token } = await issueToken();
        return token;
    }

    // 재발급 직렬화 — 동시 재발급으로 인한 이전 토큰 무효화 race 방지
    const locked = await acquireLock(REFRESH_LOCK_KEY, 10);
    if (locked) {
        try {
            const { token, ttl } = await issueToken();
            await cacheToken(token, ttl);
            return token;
        } finally {
            await releaseLock(REFRESH_LOCK_KEY);
        }
    }

    // 락 실패 — 다른 인스턴스가 발급 중. 캐시를 폴링.
    for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        const cached = await r.get<string>(REDIS_TOKEN_KEY);
        if (cached) return cached;
    }
    // 그래도 없으면 best-effort 직접 발급
    return forceRefreshToken();
}
```

- [ ] **Step 4: 통과 확인**

Run: `yarn test --run lib/trading/__tests__/token.test.ts`
Expected: PASS (전체 케이스).

- [ ] **Step 5: Commit**

```bash
git add lib/trading/token.ts lib/trading/__tests__/token.test.ts
git commit -m "feat(trading): OAuth2 토큰 매니저 (Redis 캐싱 + 재발급 락)"
```

---

## Phase 3 — 공통 client

### Task 3: client.ts — tossFetch + TossApiError + resolveAccountSeq

**Files:**
- Create: `lib/trading/client.ts`
- Test: `lib/trading/__tests__/client.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`lib/trading/__tests__/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../token', () => ({
    getAccessToken: vi.fn(async () => 'tok-abc'),
    forceRefreshToken: vi.fn(async () => 'tok-refreshed'),
}));

function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

describe('tossFetch', () => {
    beforeEach(() => {
        vi.resetModules();
        mockFetch.mockReset();
    });
    afterEach(() => vi.unstubAllEnvs());

    it('성공 시 ApiResponse envelope에서 result 언랩', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: { foo: 'bar' } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ foo: 'bar' });
    });

    it('Authorization Bearer 토큰 주입', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: {} }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/test');
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.headers.Authorization).toBe('Bearer tok-abc');
    });

    it('account:true면 X-Tossinvest-Account 헤더 부착 (accountSeq 조회)', async () => {
        // 1st call: GET /accounts → result[0].accountSeq=7
        mockFetch
            .mockResolvedValueOnce(res({ result: [{ accountNo: '1', accountSeq: 7, accountType: 'BROKERAGE' }] }))
            .mockResolvedValueOnce(res({ result: { ok: true } }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/holdings', { account: true });
        const [, opts] = mockFetch.mock.calls[1];
        expect(opts.headers['X-Tossinvest-Account']).toBe('7');
    });

    it('query 파라미터를 URL에 직렬화', async () => {
        mockFetch.mockResolvedValueOnce(res({ result: [] }));
        const { tossFetch } = await import('../client');
        await tossFetch('GET', '/api/v1/prices', { query: { symbols: 'AAPL,MSFT' } });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain('symbols=AAPL%2CMSFT');
    });

    it('worst: 4xx 에러를 TossApiError(code 보존)로 throw', async () => {
        mockFetch.mockResolvedValueOnce(
            res({ error: { code: 'insufficient-buying-power', message: '부족', requestId: 'r1' } }, 422),
        );
        const { tossFetch, TossApiError } = await import('../client');
        const err = await tossFetch('POST', '/api/v1/orders', { body: {} }).catch((e) => e);
        expect(err).toBeInstanceOf(TossApiError);
        expect(err.code).toBe('insufficient-buying-power');
        expect(err.status).toBe(422);
    });

    it('worst: 401이면 토큰 강제 재발급 후 1회 재시도', async () => {
        const { forceRefreshToken } = await import('../token');
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'unauthorized' } }, 401))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ ok: 1 });
        expect(forceRefreshToken).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: GET 5xx는 2회 재시도 후 성공', async () => {
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ ok: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: GET 5xx 지속 시 최종 throw', async () => {
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res('err', 502))
            .mockResolvedValueOnce(res('err', 503));
        const { tossFetch } = await import('../client');
        await expect(tossFetch('GET', '/api/v1/test')).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('worst: POST는 clientOrderId 없으면 5xx에서 재시도 금지', async () => {
        mockFetch.mockResolvedValueOnce(res('err', 500));
        const { tossFetch } = await import('../client');
        await expect(tossFetch('POST', '/api/v1/orders', { body: { symbol: 'A' } })).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('worst: POST에 clientOrderId 있으면 5xx 재시도 허용(멱등)', async () => {
        mockFetch
            .mockResolvedValueOnce(res('err', 500))
            .mockResolvedValueOnce(res({ result: { orderId: 'o1' } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('POST', '/api/v1/orders', {
            body: { clientOrderId: 'co-1', symbol: 'A' },
        });
        expect(out).toEqual({ orderId: 'o1' });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('worst: 429는 Retry-After 존중 후 재시도', async () => {
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'rate-limited' } }, 429, { 'Retry-After': '0' }))
            .mockResolvedValueOnce(res({ result: { ok: 1 } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('GET', '/api/v1/test');
        expect(out).toEqual({ ok: 1 });
    });

    it('worst: 409 request-in-progress 재시도', async () => {
        mockFetch
            .mockResolvedValueOnce(res({ error: { code: 'request-in-progress' } }, 409))
            .mockResolvedValueOnce(res({ result: { orderId: 'o1' } }));
        const { tossFetch } = await import('../client');
        const out = await tossFetch('POST', '/api/v1/orders', { body: { clientOrderId: 'c1' } });
        expect(out).toEqual({ orderId: 'o1' });
    });

    it('worst: 409 idempotency-key-conflict는 재시도 없이 throw', async () => {
        mockFetch.mockResolvedValueOnce(res({ error: { code: 'idempotency-key-conflict' } }, 409));
        const { tossFetch, TossApiError } = await import('../client');
        const err = await tossFetch('POST', '/api/v1/orders', { body: { clientOrderId: 'c1' } }).catch((e) => e);
        expect(err).toBeInstanceOf(TossApiError);
        expect(err.code).toBe('idempotency-key-conflict');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
```

> 참고: 재시도 대기시간 테스트의 지연을 줄이기 위해 구현은 `Retry-After`가 `0`이면 즉시 재시도하도록 한다. 다른 백오프도 테스트에서는 `vi.useFakeTimers()` 또는 짧은 base delay로 처리. base delay는 환경변수/상수로 두고 테스트에서 작게 stub하지 말고, 위 케이스처럼 `Retry-After: '0'`·기본 backoff를 짧게(예: 테스트에선 timer mock) 다룬다.

- [ ] **Step 2: 실패 확인**

Run: `yarn test --run lib/trading/__tests__/client.test.ts`
Expected: FAIL — `Cannot find module '../client'`.

- [ ] **Step 3: client.ts 구현**

```typescript
import { getAccessToken, forceRefreshToken } from './token';
import { Redis } from '@upstash/redis';

const BASE_URL = 'https://openapi.tossinvest.com';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const ACCOUNT_SEQ_KEY = 'toss:account:seq';

export class TossApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public status: number,
        public data?: unknown,
    ) {
        super(message);
        this.name = 'TossApiError';
    }
}

interface TossFetchOptions {
    query?: Record<string, string>;
    body?: unknown;
    account?: boolean;
}

let redis: Redis | null = null;
function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

let memoSeq: number | null = null;
export async function resolveAccountSeq(): Promise<number> {
    if (memoSeq != null) return memoSeq;
    const r = getRedis();
    if (r) {
        const cached = await r.get<number>(ACCOUNT_SEQ_KEY);
        if (cached != null) {
            memoSeq = Number(cached);
            return memoSeq;
        }
    }
    const accounts = await tossFetch<Array<{ accountSeq: number; accountType: string }>>(
        'GET',
        '/api/v1/accounts',
    );
    const brokerage = accounts.find((a) => a.accountType === 'BROKERAGE') ?? accounts[0];
    if (!brokerage) throw new Error('No Toss account found');
    memoSeq = brokerage.accountSeq;
    if (r) await r.set(ACCOUNT_SEQ_KEY, memoSeq, { ex: 86400 });
    return memoSeq;
}

function parseError(status: number, text: string): TossApiError {
    try {
        const json = JSON.parse(text);
        const e = json.error ?? json; // OAuth2 error는 {error, error_description}
        const code = e.code ?? e.error ?? `http-${status}`;
        const message = e.message ?? e.error_description ?? text;
        return new TossApiError(code, message, status, e.data);
    } catch {
        return new TossApiError(`http-${status}`, text, status);
    }
}

const RETRYABLE_CONFLICT = new Set(['request-in-progress']);

export async function tossFetch<T>(
    method: string,
    path: string,
    opts: TossFetchOptions = {},
): Promise<T> {
    const hasClientOrderId =
        method === 'POST' &&
        typeof opts.body === 'object' &&
        opts.body !== null &&
        'clientOrderId' in (opts.body as Record<string, unknown>);

    let url = `${BASE_URL}${path}`;
    if (opts.query) url += `?${new URLSearchParams(opts.query).toString()}`;

    let triedRefresh = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${await getAccessToken()}`,
        };
        if (opts.body != null) headers['Content-Type'] = 'application/json';
        if (opts.account) headers['X-Tossinvest-Account'] = String(await resolveAccountSeq());

        const httpRes = await fetch(url, {
            method,
            headers,
            body: opts.body != null ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (httpRes.ok) {
            const json = (await httpRes.json()) as { result?: T };
            return (json.result ?? (json as unknown)) as T;
        }

        const text = await httpRes.text();
        const err = parseError(httpRes.status, text);

        // 401 → 토큰 강제 재발급 1회 재시도
        if (httpRes.status === 401 && !triedRefresh) {
            triedRefresh = true;
            await forceRefreshToken();
            continue;
        }

        // 409: request-in-progress만 재시도, idempotency-key-conflict 등은 throw
        if (httpRes.status === 409) {
            if (RETRYABLE_CONFLICT.has(err.code) && attempt < MAX_RETRIES) {
                await delay(BASE_DELAY_MS);
                continue;
            }
            throw err;
        }

        // 429: Retry-After 존중
        if (httpRes.status === 429 && attempt < MAX_RETRIES) {
            const ra = Number(httpRes.headers.get('Retry-After') ?? '1');
            await delay(Number.isFinite(ra) ? ra * 1000 : BASE_DELAY_MS);
            continue;
        }

        // 5xx 재시도: GET은 항상, POST는 clientOrderId 있을 때만(멱등)
        const retriable5xx = httpRes.status >= 500 && (method === 'GET' || hasClientOrderId);
        if (retriable5xx && attempt < MAX_RETRIES) {
            await delay(BASE_DELAY_MS * Math.pow(2, attempt));
            continue;
        }

        throw err;
    }

    throw new TossApiError('exhausted', `Toss API ${method} ${path} failed`, 0);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
```

> 테스트에서 backoff/429 대기 지연을 피하려면 `vi.useFakeTimers()`로 타이머를 진행시키거나, `Retry-After: '0'`을 사용한다. 5xx 백오프 케이스는 `vi.useFakeTimers()` + `vi.runAllTimersAsync()` 패턴으로 작성.

- [ ] **Step 4: 통과 확인 (필요 시 fake timers 적용)**

Run: `yarn test --run lib/trading/__tests__/client.test.ts`
Expected: PASS. 5xx 재시도 케이스가 느리면 해당 테스트에 `vi.useFakeTimers()` 적용 후 `await vi.runAllTimersAsync()`로 진행.

- [ ] **Step 5: Commit**

```bash
git add lib/trading/client.ts lib/trading/__tests__/client.test.ts
git commit -m "feat(trading): 공통 tossFetch 클라이언트 (에러코드·재시도·계좌헤더)"
```

---

## Phase 4 — account.ts

### Task 4: account.ts — holdings/buying-power/sellable/cancel

**Files:**
- Create: `lib/trading/account.ts`
- Test: `lib/trading/__tests__/account.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`lib/trading/__tests__/account.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTossFetch = vi.fn();
vi.mock('../client', () => ({
    tossFetch: (...args: unknown[]) => mockTossFetch(...args),
    TossApiError: class extends Error {},
}));

describe('account', () => {
    beforeEach(() => {
        vi.resetModules();
        mockTossFetch.mockReset();
    });

    it('getHoldings: HoldingsItem을 number로 정규화', async () => {
        mockTossFetch.mockResolvedValueOnce({
            items: [
                {
                    symbol: 'IONQ',
                    name: '아이온큐',
                    marketCountry: 'US',
                    currency: 'USD',
                    quantity: '0.013315',
                    lastPrice: '59.07',
                    averagePurchasePrice: '43.404581',
                    profitLoss: { amount: '0.208585' },
                },
            ],
        });
        const { getHoldings } = await import('../account');
        const holdings = await getHoldings();
        expect(holdings).toEqual([
            {
                symbol: 'IONQ',
                quantity: 0.013315,
                avgPrice: 43.404581,
                currentPrice: 59.07,
                pnl: 0.208585,
                marketCountry: 'US',
                currency: 'USD',
            },
        ]);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/holdings', { account: true });
    });

    it('getHoldings: 빈 보유 시 빈 배열', async () => {
        mockTossFetch.mockResolvedValueOnce({ items: [] });
        const { getHoldings } = await import('../account');
        expect(await getHoldings()).toEqual([]);
    });

    it('worst: getHoldings items 누락 시 빈 배열', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { getHoldings } = await import('../account');
        expect(await getHoldings()).toEqual([]);
    });

    it('getBuyingPower: USD 매수가능액 number 반환', async () => {
        mockTossFetch.mockResolvedValueOnce({ currency: 'USD', cashBuyingPower: '1131.38' });
        const { getBuyingPower } = await import('../account');
        expect(await getBuyingPower('USD')).toBe(1131.38);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/buying-power', {
            account: true,
            query: { currency: 'USD' },
        });
    });

    it('worst: getBuyingPower 값이 비정상이면 0', async () => {
        mockTossFetch.mockResolvedValueOnce({ currency: 'USD', cashBuyingPower: 'abc' });
        const { getBuyingPower } = await import('../account');
        expect(await getBuyingPower('USD')).toBe(0);
    });

    it('getSellableQuantity: number 반환', async () => {
        mockTossFetch.mockResolvedValueOnce({ sellableQuantity: '100' });
        const { getSellableQuantity } = await import('../account');
        expect(await getSellableQuantity('AAPL')).toBe(100);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/sellable-quantity', {
            account: true,
            query: { symbol: 'AAPL' },
        });
    });

    it('worst: getSellableQuantity 값 누락 시 0', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { getSellableQuantity } = await import('../account');
        expect(await getSellableQuantity('AAPL')).toBe(0);
    });

    it('cancelOrder: POST cancel 경로 호출', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1' });
        const { cancelOrder } = await import('../account');
        await cancelOrder('o1');
        expect(mockTossFetch).toHaveBeenCalledWith('POST', '/api/v1/orders/o1/cancel', {
            account: true,
        });
    });

    it('worst: cancelOrder 에러 전파', async () => {
        mockTossFetch.mockRejectedValueOnce(new Error('cancel failed'));
        const { cancelOrder } = await import('../account');
        await expect(cancelOrder('o1')).rejects.toThrow('cancel failed');
    });

    it('isUsMarketOpen: 정규장 세션 있으면 true', async () => {
        mockTossFetch.mockResolvedValueOnce({ today: { date: '2026-06-11', regularMarket: { start: 'x' } } });
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(true);
        expect(mockTossFetch).toHaveBeenCalledWith('GET', '/api/v1/market-calendar/US', {});
    });

    it('worst: 휴장(regularMarket null)이면 false', async () => {
        mockTossFetch.mockResolvedValueOnce({ today: { date: '2026-06-11', regularMarket: null } });
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(false);
    });

    it('worst: today 누락 시 false (보수적)', async () => {
        mockTossFetch.mockResolvedValueOnce({});
        const { isUsMarketOpen } = await import('../account');
        expect(await isUsMarketOpen()).toBe(false);
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `yarn test --run lib/trading/__tests__/account.test.ts`
Expected: FAIL — `Cannot find module '../account'`.

- [ ] **Step 3: account.ts 구현**

```typescript
import { tossFetch } from './client';
import { safeNumber } from '../validation';
import type { TossHolding } from './types';

interface HoldingsItemRaw {
    symbol: string;
    name: string;
    marketCountry: string;
    currency: string;
    quantity: string;
    lastPrice: string;
    averagePurchasePrice: string;
    profitLoss?: { amount?: string };
}

export async function getHoldings(): Promise<TossHolding[]> {
    const overview = await tossFetch<{ items?: HoldingsItemRaw[] }>('GET', '/api/v1/holdings', {
        account: true,
    });
    const items = overview.items ?? [];
    return items.map((it) => ({
        symbol: it.symbol,
        quantity: safeNumber(it.quantity, 0),
        avgPrice: safeNumber(it.averagePurchasePrice, 0),
        currentPrice: safeNumber(it.lastPrice, 0),
        pnl: safeNumber(it.profitLoss?.amount, 0),
        marketCountry: it.marketCountry,
        currency: it.currency,
    }));
}

export async function getBuyingPower(currency: 'USD' | 'KRW'): Promise<number> {
    const res = await tossFetch<{ cashBuyingPower: string }>('GET', '/api/v1/buying-power', {
        account: true,
        query: { currency },
    });
    return safeNumber(res.cashBuyingPower, 0);
}

export async function getSellableQuantity(symbol: string): Promise<number> {
    const res = await tossFetch<{ sellableQuantity: string }>('GET', '/api/v1/sellable-quantity', {
        account: true,
        query: { symbol },
    });
    return safeNumber(res.sellableQuantity, 0);
}

export async function cancelOrder(orderId: string): Promise<void> {
    await tossFetch('POST', `/api/v1/orders/${orderId}/cancel`, { account: true });
}

// 미국 정규장 영업일 여부. 휴장이면 모든 세션이 null. 조회 실패/today 누락 시 보수적으로 false.
export async function isUsMarketOpen(): Promise<boolean> {
    const cal = await tossFetch<{ today?: { regularMarket?: unknown | null } }>(
        'GET',
        '/api/v1/market-calendar/US',
        {},
    );
    return cal.today?.regularMarket != null;
}
```

> `safeNumber(value, fallback)`가 `lib/validation.ts`에 있는지 확인. 시그니처가 다르면(예: `safeNumber(value)`만) `Number.isFinite(Number(x)) ? Number(x) : 0`로 인라인 처리. 구현 전 `lib/validation.ts`를 Read하여 정확한 시그니처를 맞출 것.

- [ ] **Step 4: 통과 확인**

Run: `yarn test --run lib/trading/__tests__/account.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/trading/account.ts lib/trading/__tests__/account.test.ts
git commit -m "feat(trading): 계좌·보유·매수가능·매도가능·취소 API"
```

---

## Phase 5 — orders.ts (파사드 + 폴링)

### Task 5: orders.ts — issueOrder / getOrder / 파사드

**Files:**
- Create: `lib/trading/orders.ts`
- Test: `lib/trading/__tests__/orders.test.ts`
- Delete: `lib/trading/toss-client.ts`, `lib/trading/order.ts`, `lib/trading/__tests__/toss-client.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`lib/trading/__tests__/orders.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTossFetch = vi.fn();
class FakeTossApiError extends Error {
    constructor(public code: string, msg: string, public status: number) {
        super(msg);
    }
}
vi.mock('../client', () => ({
    tossFetch: (...args: unknown[]) => mockTossFetch(...args),
    TossApiError: FakeTossApiError,
}));

// crypto.randomUUID 고정
vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed-0000-0000-000000000000' });

describe('orders', () => {
    beforeEach(() => {
        vi.resetModules();
        mockTossFetch.mockReset();
    });

    // ── 입력 검증 (worst) ──
    it('worst: 빈 심볼 → Invalid symbol', async () => {
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('', 10)).rejects.toThrow('Invalid symbol');
    });
    it('worst: 수량 0 → 양의 정수', async () => {
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 0)).rejects.toThrow('positive integer');
    });
    it('worst: 소수 수량 거부', async () => {
        const { executeSellOrder } = await import('../orders');
        await expect(executeSellOrder('AAPL', 2.5)).rejects.toThrow('positive integer');
    });

    // ── issueOrder body 포맷 ──
    it('issueOrder: BUY/MARKET, quantity string, clientOrderId 전송', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1', clientOrderId: 'co1' }) // POST /orders
            .mockResolvedValueOnce({ orderId: 'o1', status: 'FILLED', execution: { filledQuantity: '10', averageFilledPrice: '70000' } }); // poll
        const { executeBuyOrder } = await import('../orders');
        await executeBuyOrder('005930', 10, 'co1');
        const [method, path, opts] = mockTossFetch.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe('/api/v1/orders');
        expect(opts.account).toBe(true);
        expect(opts.body).toEqual({
            clientOrderId: 'co1',
            symbol: '005930',
            side: 'BUY',
            orderType: 'MARKET',
            quantity: '10',
        });
    });

    it('clientOrderId 미전달 시 randomUUID 사용', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValueOnce({ orderId: 'o1', status: 'FILLED', execution: { filledQuantity: '5', averageFilledPrice: '100' } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 5);
        expect(outcome.clientOrderId).toBe('uuid-fixed-0000-0000-000000000000');
    });

    // ── 폴링 상태 전이 ──
    it('FILLED 즉시 → status filled + 체결가/수량', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValueOnce({ orderId: 'o1', status: 'FILLED', execution: { filledQuantity: '10', averageFilledPrice: '292.18' } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome).toMatchObject({
            orderId: 'o1',
            status: 'filled',
            filledQuantity: 10,
            avgFilledPrice: 292.18,
        });
    });

    it('worst: 끝까지 PENDING이면 status pending', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValue({ orderId: 'o1', status: 'PENDING', execution: { filledQuantity: '0', averageFilledPrice: null } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('pending');
    });

    it('PARTIAL_FILLED → status partial + 체결분', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValue({ orderId: 'o1', status: 'PARTIAL_FILLED', execution: { filledQuantity: '3', averageFilledPrice: '50' } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('partial');
        expect(outcome.filledQuantity).toBe(3);
    });

    it('REJECTED 폴링 → status rejected', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValueOnce({ orderId: 'o1', status: 'REJECTED', execution: { filledQuantity: '0', averageFilledPrice: null } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('rejected');
    });

    it('CANCELED 폴링 → status canceled', async () => {
        mockTossFetch
            .mockResolvedValueOnce({ orderId: 'o1' })
            .mockResolvedValueOnce({ orderId: 'o1', status: 'CANCELED', execution: { filledQuantity: '0', averageFilledPrice: null } });
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('canceled');
    });

    // ── 422 비즈니스 에러 정규화 ──
    it('worst: 422 insufficient-buying-power → rejected(rejectReason=code)', async () => {
        mockTossFetch.mockRejectedValueOnce(new FakeTossApiError('insufficient-buying-power', '부족', 422));
        const { executeBuyOrder } = await import('../orders');
        const outcome = await executeBuyOrder('AAPL', 10, 'c1');
        expect(outcome.status).toBe('rejected');
        expect(outcome.rejectReason).toBe('insufficient-buying-power');
    });

    it('worst: 500 시스템 오류는 throw 전파 (rejected로 안 삼킴)', async () => {
        mockTossFetch.mockRejectedValueOnce(new FakeTossApiError('internal-error', 'fail', 500));
        const { executeBuyOrder } = await import('../orders');
        await expect(executeBuyOrder('AAPL', 10, 'c1')).rejects.toThrow();
    });

    // ── getOrder 정규화 ──
    it('getOrder: Order를 OrderDetail로 정규화', async () => {
        mockTossFetch.mockResolvedValueOnce({
            orderId: 'o1',
            status: 'FILLED',
            canceledAt: null,
            execution: { filledQuantity: '10', averageFilledPrice: '70000' },
        });
        const { getOrder } = await import('../orders');
        const detail = await getOrder('o1');
        expect(detail).toEqual({
            orderId: 'o1',
            status: 'FILLED',
            filledQuantity: 10,
            avgFilledPrice: 70000,
            canceledAt: null,
        });
    });

    it('worst: getOrder execution 누락 시 filledQuantity 0', async () => {
        mockTossFetch.mockResolvedValueOnce({ orderId: 'o1', status: 'PENDING', canceledAt: null });
        const { getOrder } = await import('../orders');
        const detail = await getOrder('o1');
        expect(detail.filledQuantity).toBe(0);
        expect(detail.avgFilledPrice).toBeNull();
    });
});
```

> 폴링 간격 때문에 테스트가 느려지지 않도록, 폴링 대기는 `vi.useFakeTimers()` + `await vi.runAllTimersAsync()`로 진행하거나, 폴링 간격/횟수를 모듈 상수로 두고 위 테스트처럼 첫 폴에서 종결되는 경우(FILLED/REJECTED/CANCELED)는 타이머가 개입하지 않게 한다. PENDING/PARTIAL 지속 케이스는 fake timers로 처리.

- [ ] **Step 2: 실패 확인**

Run: `yarn test --run lib/trading/__tests__/orders.test.ts`
Expected: FAIL — `Cannot find module '../orders'`.

- [ ] **Step 3: orders.ts 구현**

```typescript
import { tossFetch, TossApiError } from './client';
import { safeNumber } from '../validation';
import type { IssueOrderRequest, OrderOutcome, OrderDetail, OrderSide, TossOrderStatus } from './types';

const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 1500;

function validateOrderInputs(symbol: string, quantity: number): void {
    if (!symbol || typeof symbol !== 'string') throw new Error('Invalid symbol');
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
    }
}

export async function issueOrder(req: IssueOrderRequest): Promise<{ orderId: string }> {
    const res = await tossFetch<{ orderId: string }>('POST', '/api/v1/orders', {
        account: true,
        body: {
            clientOrderId: req.clientOrderId,
            symbol: req.symbol,
            side: req.side,
            orderType: req.orderType,
            quantity: String(req.quantity),
        },
    });
    return { orderId: res.orderId };
}

interface OrderRaw {
    orderId: string;
    status: TossOrderStatus;
    canceledAt?: string | null;
    execution?: { filledQuantity?: string; averageFilledPrice?: string | null };
}

export async function getOrder(orderId: string): Promise<OrderDetail> {
    const o = await tossFetch<OrderRaw>('GET', `/api/v1/orders/${orderId}`, { account: true });
    return {
        orderId: o.orderId,
        status: o.status,
        filledQuantity: safeNumber(o.execution?.filledQuantity, 0),
        avgFilledPrice:
            o.execution?.averageFilledPrice != null
                ? safeNumber(o.execution.averageFilledPrice, 0)
                : null,
        canceledAt: o.canceledAt ?? null,
    };
}

function mapStatus(s: TossOrderStatus): OrderOutcome['status'] | null {
    switch (s) {
        case 'FILLED':
            return 'filled';
        case 'PARTIAL_FILLED':
            return 'partial';
        case 'REJECTED':
        case 'CANCEL_REJECTED':
        case 'REPLACE_REJECTED':
            return 'rejected';
        case 'CANCELED':
            return 'canceled';
        default:
            return null; // PENDING/PENDING_* → 미확정
    }
}

async function executeOrder(
    side: OrderSide,
    symbol: string,
    quantity: number,
    clientOrderId?: string,
): Promise<OrderOutcome> {
    validateOrderInputs(symbol, quantity);
    const coid = clientOrderId ?? crypto.randomUUID();

    let orderId: string;
    try {
        ({ orderId } = await issueOrder({
            symbol,
            side,
            orderType: 'MARKET',
            quantity,
            clientOrderId: coid,
        }));
    } catch (err) {
        // 비즈니스 거부(4xx 422 등)는 rejected로 정규화, 시스템 오류(5xx)는 전파
        if (err instanceof TossApiError && err.status >= 400 && err.status < 500) {
            return { orderId: '', clientOrderId: coid, status: 'rejected', rejectReason: err.code };
        }
        throw err;
    }

    // 인라인 폴링
    let last: OrderDetail | null = null;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        last = await getOrder(orderId);
        const mapped = mapStatus(last.status);
        if (mapped) {
            return {
                orderId,
                clientOrderId: coid,
                status: mapped,
                filledQuantity: last.filledQuantity,
                avgFilledPrice: last.avgFilledPrice ?? undefined,
            };
        }
        if (i < POLL_ATTEMPTS - 1) await delay(POLL_INTERVAL_MS);
    }

    // 미확정
    return {
        orderId,
        clientOrderId: coid,
        status: 'pending',
        filledQuantity: last?.filledQuantity,
        avgFilledPrice: last?.avgFilledPrice ?? undefined,
    };
}

export function executeBuyOrder(symbol: string, quantity: number, clientOrderId?: string) {
    return executeOrder('BUY', symbol, quantity, clientOrderId);
}

export function executeSellOrder(symbol: string, quantity: number, clientOrderId?: string) {
    return executeOrder('SELL', symbol, quantity, clientOrderId);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: 통과 확인**

Run: `yarn test --run lib/trading/__tests__/orders.test.ts`
Expected: PASS.

- [ ] **Step 5: 구 파일 삭제**

```bash
git rm lib/trading/toss-client.ts lib/trading/order.ts lib/trading/__tests__/toss-client.test.ts
```

- [ ] **Step 6: 커버리지 게이트 확인**

Run: `yarn test:coverage --run lib/trading`
Expected: lib/trading 커버리지 lines/functions/branches/statements 모두 ≥90%. 미달 시 부족한 분기에 대한 테스트 추가.

- [ ] **Step 7: Commit**

```bash
git add lib/trading/orders.ts lib/trading/__tests__/orders.test.ts
git commit -m "feat(trading): 비동기 주문 파사드 + 인라인 폴링 + getOrder

기존 toss-client.ts/order.ts 대체"
```

---

## Phase 6 — DB 스키마

### Task 6: order_tracking.client_order_id 컬럼 추가

**Files:**
- Modify: `lib/db/schema.ts:96-108`
- Modify: `lib/db/queries.ts:421-464`
- Create: drizzle migration (자동 생성)

- [ ] **Step 1: 스키마에 컬럼 추가**

`lib/db/schema.ts`의 `orderTracking` 정의에 `tossOrderId` 아래로 추가:

```typescript
    tossOrderId: text('toss_order_id'),
    clientOrderId: text('client_order_id'),
    status: text('status').notNull(),
```

- [ ] **Step 2: createOrderTracking에 clientOrderId 지원**

`lib/db/queries.ts` `createOrderTracking` params와 values에 추가:

```typescript
    params: {
        idempotencyKey: string;
        clientOrderId?: string;
        symbol: string;
        side: string;
        quantity: number;
        tossOrderId?: string;
        status: string;
        cronRunId?: string;
    },
```
values에 `clientOrderId: params.clientOrderId,` 추가.

- [ ] **Step 3: 마이그레이션 생성**

Run: `yarn db:generate`
Expected: `drizzle/`에 `client_order_id` 컬럼 추가 SQL 마이그레이션 파일 생성.

- [ ] **Step 4: 타입체크**

Run: `yarn typecheck`
Expected: PASS (스키마/쿼리 변경 일관).

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/queries.ts drizzle/
git commit -m "feat(db): order_tracking에 client_order_id 컬럼 추가"
```

> 마이그레이션 실 적용(`yarn db:migrate`)은 배포 단계에서 수행. 계획상 생성까지만.

---

## Phase 7 — 호출부 통합

### Task 7: execute.ts — OrderOutcome 매핑 + 안전장치 가드

**Files:**
- Modify: `api/cron/execute.ts` (import; ~356-455 매도 경로; ~930-1212 자동 주문 경로)

import 교체: `import { executeBuyOrder, executeSellOrder } from '../../lib/trading/order';` → `'../../lib/trading/orders'`. 추가: `import { getBuyingPower, getSellableQuantity, isUsMarketOpen } from '../../lib/trading/account';`

- [ ] **Step 0: 미국 휴장 게이팅 (진입부)**

락 획득 + 서킷브레이커 통과 직후, 라이브 모드(`auto`/`semi_auto`)일 때 휴장이면 조기 종료:

```typescript
const tradingMode = /* 기존 config 조회 값 */;
if (tradingMode !== 'dry_run') {
    const marketOpen = await isUsMarketOpen().catch(() => true); // 조회 실패 시 기존 시간기반 동작 유지
    if (!marketOpen) {
        return Response.json({ skipped: true, reason: 'us-market-holiday' });
    }
}
```
(락은 `finally`에서 해제되므로 early return 전 lockAcquired 처리 흐름을 따를 것.)

- [ ] **Step 1: clientOrderId 생성 + createOrderTracking 전달**

자동 주문 블록(~930)에서 `idempotencyKey` 생성 직후 추가:

```typescript
const clientOrderId = crypto.randomUUID();
await createOrderTracking(db, {
    idempotencyKey,
    clientOrderId,
    symbol: item.symbol,
    side: autoSide,
    quantity: decision.quantity,
    status: 'submitted',
    cronRunId,
});
```
그리고 `orderFn(item.symbol, decision.quantity, clientOrderId)`로 호출(기존 `idempotencyKey` 대신 `clientOrderId` 전달).

- [ ] **Step 2: OrderOutcome 상태 매핑 적용**

기존 `orderResult.status === 'submitted'` → `'pending'`, `orderResult.filledPrice` → `orderResult.avgFilledPrice`로 치환. 상태별 분기를 아래 규칙으로 정리:

```typescript
// updateOrderTracking status 매핑: OrderOutcome.status를 그대로 저장 가능
await updateOrderTracking(db, idempotencyKey, {
    tossOrderId: orderResult.orderId || undefined,
    status: orderResult.status, // 'filled'|'partial'|'pending'|'rejected'|'canceled'
    filledPrice: orderResult.avgFilledPrice ?? undefined,
    resolvedAt: orderResult.status === 'pending' ? undefined : new Date(),
});

if (orderResult.status === 'rejected' || orderResult.status === 'canceled') {
    // 기존 rejected 분기 로직 (이메일 + order_rejected decision)
}
if (orderResult.status === 'pending') {
    // 기존 submitted 분기 (미체결 이메일 + order_submitted decision) — reconcile가 확정
}
// 'filled' 또는 'partial': 실제 체결가(avgFilledPrice)로 trade/position 기록
const filledPrice = orderResult.avgFilledPrice;
const actualQuantity = orderResult.filledQuantity ?? decision.quantity;
if (filledPrice == null) {
    // avgFilledPrice 없는 체결(이례적) → 기존 'fill_price_unknown' 예상가 경로 유지
} else {
    // 기존 정상 체결 기록 경로 (filledPrice 사용)
}
```

> 핵심: 이제 `'filled'`면 `avgFilledPrice`가 실제값으로 들어오므로 "예상가 기록" 경로는 `filledPrice == null`인 예외 상황에만 탄다. 기존 코드의 `!orderResult.filledPrice` 분기 조건을 `filledPrice == null`로 바꾸고 변수명을 `avgFilledPrice` 기반으로 정리.

- [ ] **Step 3: 매수 전 buying-power 가드**

매수/평단매수 결정 직전에 (run당 1회 캐시):

```typescript
// 루프 밖에서 1회: const usdBuyingPower = await getBuyingPower('USD').catch(() => null);
// 매수 직전:
const estCost = currentPrice * decision.quantity;
if (usdBuyingPower != null && estCost > usdBuyingPower) {
    decisions.push({ symbol: item.symbol, action: 'skipped_insufficient_cash', score: decision.score });
    decisionPushed = true;
    break;
}
```

- [ ] **Step 4: 매도 전 sellable-quantity 가드**

매도 경로(~356, ~1030)에서 주문 직전:

```typescript
const sellable = await getSellableQuantity(position.symbol).catch(() => null);
if (sellable != null) {
    if (sellable <= 0) { /* 스킵 + 로그 */ break; }
    if (decision.quantity > sellable) decision.quantity = Math.floor(sellable); // 클램프
}
```

- [ ] **Step 5: 타입체크 + 기존 execute 테스트 갱신**

Run: `yarn typecheck && yarn test --run api/cron`
Expected: PASS. 기존 execute 테스트가 `orderResult.status: 'filled'/'submitted'`를 mock하던 부분을 `OrderOutcome`(`'filled'`/`'pending'` + `avgFilledPrice`)으로 갱신. lib/trading은 모킹.

- [ ] **Step 6: Commit**

```bash
git add api/cron/execute.ts
git commit -m "feat(execute): 비동기 OrderOutcome 매핑 + 매수/매도 안전장치 가드"
```

> `skipped_insufficient_cash`/매도 클램프에 대한 단위 테스트는 Step 5에서 함께 작성(happy + worst: 현금부족, sellable 0, 클램프 발생).

---

### Task 8: reconcile.ts — getOrder 폴링 + cancelOrder + holdings 정합성

**Files:**
- Modify: `api/cron/reconcile.ts`

- [ ] **Step 1: import 추가**

```typescript
import { getOrder } from '../../lib/trading/orders';
import { getHoldings, cancelOrder } from '../../lib/trading/account';
```

- [ ] **Step 2: submitted/pending 주문 실제 상태 조회**

기존 `for (const order of submitted)` 루프에서 타임아웃 분기 전에 `tossOrderId`가 있으면 실제 조회:

```typescript
if (order.tossOrderId) {
    const detail = await getOrder(order.tossOrderId).catch(() => null);
    if (detail) {
        if (detail.status === 'FILLED' || detail.status === 'PARTIAL_FILLED') {
            await updateOrderTracking(db, order.idempotencyKey, {
                status: detail.status === 'FILLED' ? 'filled' : 'partial',
                filledPrice: detail.avgFilledPrice ?? undefined,
                resolvedAt: new Date(),
            });
            results.push({ id: order.id, symbol: order.symbol, action: 'resolved' });
            continue;
        }
        if (detail.status === 'CANCELED' || detail.status === 'REJECTED') {
            await updateOrderTracking(db, order.idempotencyKey, {
                status: detail.status.toLowerCase(),
                resolvedAt: new Date(),
            });
            results.push({ id: order.id, symbol: order.symbol, action: detail.status.toLowerCase() });
            continue;
        }
        // 여전히 PENDING → 30분+면 취소
        if (age > SUBMITTED_TIMEOUT_MS) {
            await cancelOrder(order.tossOrderId).catch((e) => console.error('[cancel]', e));
            await updateOrderTracking(db, order.idempotencyKey, { status: 'timeout', resolvedAt: new Date() });
            // 기존 타임아웃 이메일 발송
            continue;
        }
    }
}
```

기존 타임아웃 전용 분기는 `tossOrderId`가 없는(접수 직후 실패) 경우의 fallback으로 유지.

- [ ] **Step 3: holdings 정합성 비교 추가**

`checkConsistency` 호출 뒤에:

```typescript
const holdings = await getHoldings().catch(() => null);
if (holdings) {
    // 브로커 보유 종목 ↔ DB open positions 비교, 불일치 종목 목록화
    // (수량 차이 임계 초과 시 alert 이메일)
}
```
구현: `getOpenPositions(db)`로 DB 포지션 조회 후 symbol별 수량 비교. 불일치 시 `sendErrorEmail`. (정확한 DB 조회 함수명은 `lib/db/queries.ts`에서 확인.)

- [ ] **Step 4: TODO 주석 3개 제거 + 타입체크 + 테스트**

Run: `yarn typecheck && yarn test --run api/cron`
Expected: PASS. reconcile 테스트에 worst case 추가: getOrder가 FILLED 반환 시 resolved, 30분+ PENDING 시 cancelOrder 호출, getOrder 실패 시 fallback 타임아웃.

- [ ] **Step 5: Commit**

```bash
git add api/cron/reconcile.ts
git commit -m "feat(reconcile): getOrder 폴링·자동취소·holdings 정합성 비교"
```

---

### Task 9: approve/[id].ts — OrderOutcome 매핑

**Files:**
- Modify: `api/approve/[id].ts:1-2`(import), `:76-243`

- [ ] **Step 1: import 교체 + clientOrderId 생성**

`'../../lib/trading/order'` → `'../../lib/trading/orders'`. 주문 직전 `const clientOrderId = crypto.randomUUID();` 생성해 `orderFn(order.symbol, order.quantity, clientOrderId)` 전달.

- [ ] **Step 2: OrderOutcome 매핑 적용**

Task 7과 동일 규칙: `result.filledPrice` → `result.avgFilledPrice`, `result.status` 값 매핑(`'submitted'`→`'pending'`). `if (!result.filledPrice)` → `if (result.avgFilledPrice == null)`. status가 `'rejected'`/`'canceled'`/`'pending'`일 때 분기 처리.

- [ ] **Step 3: 타입체크 + 테스트**

Run: `yarn typecheck && yarn test --run api/approve`
Expected: PASS. approve 테스트의 mock 응답을 OrderOutcome 형식으로 갱신. worst case: rejected/pending 승인 처리.

- [ ] **Step 4: Commit**

```bash
git add api/approve/[id].ts
git commit -m "feat(approve): 비동기 OrderOutcome 매핑"
```

---

## Phase 8 — 문서/정리

### Task 10: CLAUDE.md, .env.example, 전체 검증

**Files:**
- Modify: `lib/trading/CLAUDE.md`
- Modify: `.env.example`
- Modify: `lib/db/CLAUDE.md` (order_tracking 컬럼 설명)

- [ ] **Step 1: lib/trading/CLAUDE.md 갱신**

"Placeholder. Toss API not yet available" 섹션 제거. 새 모듈 구조(token/client/account/orders), OAuth2 흐름, 비동기 폴링 모델, 재시도 정책, clientOrderId 멱등성, 안전장치를 반영. TODO 목록 제거.

- [ ] **Step 2: .env.example에서 TOSS_ACCOUNT_NO 제거**

`TOSS_APP_KEY`/`TOSS_SECRET_KEY` 주석을 "OAuth2 client_id/client_secret"로 명확화. `TOSS_ACCOUNT_NO` 줄 삭제(accountSeq는 동적 조회).

- [ ] **Step 3: 전체 검증**

Run: `yarn typecheck && yarn lint && yarn test:coverage`
Expected: 타입/린트 통과, lib/trading 커버리지 ≥90%, 전체 테스트 통과.

- [ ] **Step 4: Commit**

```bash
git add lib/trading/CLAUDE.md lib/db/CLAUDE.md .env.example
git commit -m "docs(trading): 실제 스펙 반영 + TOSS_ACCOUNT_NO 제거"
```

---

## 검증 체크리스트 (구현 완료 후)

- [ ] `yarn typecheck` 통과
- [ ] `yarn lint` 통과
- [ ] `yarn test:coverage` — lib/trading 4개 지표 모두 ≥90%
- [ ] 신규 테스트에 worst case 포함 확인: 토큰 401/네트워크실패/락실패, client 4xx/401재발급/5xx/429/409, orders 입력검증/PENDING지속/PARTIAL/REJECTED/422정규화/500전파, account 빈응답/비정상값
- [ ] `yarn db:generate` 마이그레이션 파일 존재
- [ ] 실 API 읽기전용 스모크(수동): `/oauth2/token` → `/accounts` → `/holdings` → `/buying-power` 200 확인
- [ ] DRY_RUN 모드로 execute 전체 플로우 1회 검증
- [ ] (배포 후) 소액 실주문 1건 수동 검증 — 체결가 정확 기록 확인

## 리스크/주의 (구현 중 확인)

- `lib/validation.ts`의 `safeNumber` 시그니처 확인 후 사용(없으면 인라인 가드).
- 폴링 테스트는 `vi.useFakeTimers()`로 지연 제거 — 실제 대기시간으로 테스트 느려지지 않게.
- `clientOrderId` 10분 TTL: 인라인 재시도는 수 초라 안전. reconcile은 `orderId`로 조회하므로 무관.
- 부분 체결(`partial`) 시 trade/position 기록 로직은 신규 — DB 정합성 테스트 필수.
- 라이브 키 노출 관련 키 회전은 사용자 판단(설계 문서 §11).
