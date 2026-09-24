import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import cron, { type ScheduledTask } from 'node-cron';

// api/ handlers are Web-standard `(Request) => Promise<Response>`, exposed as named
// HTTP-method exports (the same shape Vercel's Node runtime consumed). Dynamic-segment
// handlers (`approve/[id]`, `positions/[id]/close`) parse the id from their own request
// URL, so routing only needs to forward the raw Request — no param plumbing.
import { GET as analysisGET } from '../api/analysis.js';
import { POST as analysisTriggerPOST } from '../api/analysis/trigger.js';
import { POST as approvePOST } from '../api/approve/[id].js';
import { POST as authLoginPOST } from '../api/auth/login.js';
import { POST as authLogoutPOST } from '../api/auth/logout.js';
import { GET as authMeGET } from '../api/auth/me.js';
import { GET as configGET, POST as configPOST } from '../api/config.js';
import { GET as cronRunsGET } from '../api/cron-runs.js';
import { GET as healthGET } from '../api/health.js';
import { GET as pendingGET } from '../api/pending.js';
import { GET as positionsGET } from '../api/positions.js';
import { POST as positionClosePOST } from '../api/positions/[id]/close.js';
import { GET as searchGET } from '../api/search.js';
import { GET as statusGET } from '../api/status.js';
import { GET as tradesGET, POST as tradesPOST } from '../api/trades.js';
import { GET as cronExecute } from '../api/cron/execute.js';
import { GET as cronReconcile } from '../api/cron/reconcile.js';
import { GET as cronDigest } from '../api/cron/digest.js';
import { GET as cronReview } from '../api/cron/review.js';

type WebHandler = (req: Request) => Promise<Response>;

/** Forward Hono's raw Request straight to a Web-standard api/ handler. */
const fwd = (h: WebHandler) => (c: { req: { raw: Request } }) => h(c.req.raw);

/**
 * Scheduled jobs (UTC schedules; `isEtRegularSessionOpen` narrows to the actual US session).
 * Double execution across instances is prevented by the Redis SETNX lock (lib/lock.ts).
 *
 * 시간당 분석 크론 5종(technical/news/options/fundamental/congress)은 없다 — 전략이 가격만 보는
 * 일봉 규칙이 되면서 AI 분석은 신호가 난 종목에만 `review`가 부른다
 * (docs/specs/2026-09-24-daily-mean-reversion-design.md §5).
 */
export const CRON_JOBS: ReadonlyArray<{ name: string; schedule: string; handler: WebHandler }> = [
    // 5분마다 호출하고, 실제 실행 여부는 핸들러 안의 `execute_interval_min` 게이트(5·10분)가
    // 정한다. `2-59/5`는 게이트가 인정하는 모든 분(:02 :07 :12 …)을 덮는다. 판단 단계는 마감
    // 20분 전 창의 첫 틱에서 하루 1회 돈다 — 13~21시 UTC가 EDT·EST 양쪽의 창을 모두 덮는다.
    { name: 'execute', schedule: '2-59/5 13-21 * * 1-5', handler: cronExecute },
    { name: 'reconcile', schedule: '*/10 13-21 * * 1-5', handler: cronReconcile },
    // 01:00 UTC = 10:00 KST. Runs daily (including weekends) — there are no day-of-week
    // restrictions because quiet-hours notifications can be queued any day US market trades.
    { name: 'digest', schedule: '0 1 * * *', handler: cronDigest },
    // AI 진입 리뷰(기록 전용). 판단은 ET 15:40~16:00(반일장 12:40~13:00)이라 16:00 UTC부터 덮는다.
    // 처리할 신호가 없는 틱은 감사 행 없이 끝난다.
    { name: 'review', schedule: '*/10 16-21 * * 1-5', handler: cronReview },
];

export const app = new Hono();

// Whole-site noindex (trader is a private, CF-Access-gated tool) — was a vercel.json header rule.
app.use('*', async (c, next) => {
    await next();
    c.header('X-Robots-Tag', 'noindex, nofollow');
});

app.get('/api/health', fwd(healthGET));
app.post('/api/auth/login', fwd(authLoginPOST));
app.post('/api/auth/logout', fwd(authLogoutPOST));
app.get('/api/auth/me', fwd(authMeGET));
app.get('/api/analysis', fwd(analysisGET));
app.post('/api/analysis/trigger', fwd(analysisTriggerPOST));
app.post('/api/approve/:id', fwd(approvePOST));
app.get('/api/config', fwd(configGET));
app.post('/api/config', fwd(configPOST));
app.get('/api/cron-runs', fwd(cronRunsGET));
app.get('/api/pending', fwd(pendingGET));
app.get('/api/positions', fwd(positionsGET));
app.post('/api/positions/:id/close', fwd(positionClosePOST));
app.get('/api/search', fwd(searchGET));
app.get('/api/status', fwd(statusGET));
app.get('/api/trades', fwd(tradesGET));
app.post('/api/trades', fwd(tradesPOST));
// Cron endpoints stay HTTP-reachable (CRON_SECRET-gated) for manual/cutover triggering;
// node-cron calls the same handlers in-process on schedule (see startCron).
for (const { name, handler } of CRON_JOBS) app.get(`/api/cron/${name}`, fwd(handler));

// Unknown /api/* must 404, never fall through to the SPA — the old vercel.json rewrite
// source `/((?!api/).*)` likewise excluded api paths from the index.html fallback.
app.all('/api/*', (c) => c.notFound());

// 캐시 정책은 **명시한다.** 종전에는 아무 헤더도 붙이지 않아 Cloudflare가 스스로
// 판단했고(자산에 `max-age=14400`), 그 결과 SPA 폴백이 잘못 내려준 HTML 응답까지 4시간
// 캐시됐다 — 서버 결함이 CDN에 각인돼 배포를 해도 낫지 않는 상태가 됐다.
//
// 헤더는 `serveStatic`을 부르기 **전에** 예약한다. 그쪽도 `Content-Type`을 같은 방식으로
// 세운다(`c.header()` → 그 다음 `c.body()`). `onFound`에서 얹으려던 첫 시도는 응답이 이미
// 만들어진 뒤라 반영되지 않았고, `c.res`를 갈아끼우는 우회는 **본문 스트림을 소비해
// 응답을 0바이트로 만들었다** — 프로덕션에서 Cloudflare 520으로 드러났다.
const withCacheControl = (value: string, inner: MiddlewareHandler): MiddlewareHandler =>
    async function cached(c, next) {
        c.header('Cache-Control', value);
        return inner(c, next);
    };

// Static SPA: serve built assets, else fall back to index.html (client-side routing).
//
// 자산은 파일명에 콘텐츠 해시가 있으므로 같은 이름이면 같은 내용이다. 영구 캐시가
// 안전하고 `immutable`이 재검증까지 없앤다.
app.get(
    '/assets/*',
    withCacheControl('public, max-age=31536000, immutable', serveStatic({ root: './dist' })),
);
// `/`는 여기서 `dist/index.html`을 찾아 나간다(디렉터리 인덱스). 아래 폴백까지 안 가므로
// 캐시 정책을 여기에도 걸어야 한다 — 문서가 캐시되면 옛 청크를 영영 붙잡는다.
app.get('/', withCacheControl('no-cache, must-revalidate', serveStatic({ root: './dist' })));
// 나머지 정적 파일(매니페스트·아이콘 등). 해시가 없으므로 보수적으로 재검증시킨다.
app.get('/*', withCacheControl('no-cache, must-revalidate', serveStatic({ root: './dist' })));

// 해시가 박힌 자산은 **폴백에서 제외한다.**
//
// 없는 자산까지 `index.html`을 돌려주면 브라우저는 200 + `text/html`을 받고,
// `import()`는 "Failed to fetch dynamically imported module"로 실패한다. 실제로 그렇게
// 샜다 — 배포 후 옛 문서를 들고 있던 탭이 사라진 청크를 요청했고, 서버가 HTML을 주는
// 바람에 원인이 "청크 없음"이 아니라 "모듈 파싱 실패"로 위장됐다.
//
// 404를 주면 브라우저가 그 사실을 그대로 보고, `src/lib/chunk-recovery.ts`가 한 번
// 새로고침해 새 문서를 받는다. 파일명에 해시가 있으므로 404는 언제나 "이 빌드에 없는
// 파일"이고, SPA 라우트로 오인될 여지가 없다.
app.get('/assets/*', (c) => {
    // 위에서 예약한 `immutable`을 지운다 — 없는 파일을 1년 캐시하면 그 사이 배포된
    // 같은 이름의 자산(있을 수 없지만)은 물론이고 CDN이 404를 오래 들고 있게 된다.
    c.header('Cache-Control', 'no-store');
    return c.notFound();
});

// SPA 문서는 **절대 캐시하지 않는다.** 이 문서가 어떤 청크를 부를지 정하므로, 옛 문서가
// 살아 있으면 새 배포의 자산을 영영 못 찾는다 — 청크 로드 실패의 근원이다.
app.get(
    '/*',
    withCacheControl('no-cache, must-revalidate', serveStatic({ path: './dist/index.html' })),
);

/**
 * Register the cron schedules. Each tick invokes the handler in-process with a synthetic
 * CRON_SECRET-bearing Request so the handler's own auth + logic run unchanged. Returns the
 * tasks so the caller can stop them on shutdown. No-op (warns) if CRON_SECRET is unset.
 */
/**
 * 진행 중인 크론 틱. 종료 시 이것들을 기다린다 — `task.stop()`은 **다음 틱만** 막고
 * 실행 중인 콜백은 그대로 둔다. 배포(systemctl restart)가 장중에 걸리면 브로커 주문은
 * 나갔는데 booking 트랜잭션 전에 프로세스가 죽어, 브로커엔 체결·DB엔 `submitted`만
 * 남는다(복구는 reconcile 30분 뒤 + 수동).
 */
const inFlightCronTicks = new Set<Promise<unknown>>();

/** 진행 중인 크론 틱이 끝날 때까지 기다린다(상한 `timeoutMs`). */
export async function drainCron(timeoutMs = 20_000): Promise<void> {
    if (inFlightCronTicks.size === 0) return;
    console.log(`[cron] draining ${inFlightCronTicks.size} in-flight tick(s)`);
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
        Promise.allSettled([...inFlightCronTicks]),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

export function startCron(): ScheduledTask[] {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        // 프로덕션에서 이건 경고가 아니라 **전면 정지**다: 매매·정산·분석 크론이 하나도
        // 돌지 않는데 헬스체크는 200을 내므로 배포는 성공으로 기록되고, 침묵을 감시하는
        // cron-health조차 digest 크론이 돌아야 동작한다. 부팅을 실패시켜 배포가 실패하게
        // 한다. 개발 환경은 종전대로 경고 후 진행.
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                '[cron] CRON_SECRET unset in production — refusing to start with the scheduler disabled',
            );
        }
        console.warn('[cron] CRON_SECRET unset — scheduler disabled');
        return [];
    }
    return CRON_JOBS.map(({ name, schedule, handler }) =>
        cron.schedule(
            schedule,
            async () => {
                const work = (async () => {
                    try {
                        const req = new Request(`http://localhost/api/cron/${name}`, {
                            headers: { authorization: `Bearer ${secret}` },
                        });
                        const res = await handler(req);
                        console.log(`[cron:${name}] ${res.status}`);
                    } catch (err) {
                        console.error(`[cron:${name}] failed`, err);
                    }
                })();
                inFlightCronTicks.add(work);
                try {
                    await work;
                } finally {
                    inFlightCronTicks.delete(work);
                }
            },
            // 겹침 금지. 락(Redis)은 프로세스 간 방어이고 이건 같은 프로세스 안에서 이전
            // 실행이 끝나기 전에 다음 틱이 시작되는 것을 막는다 — execute가 10분 간격으로
            // 돌면서 한 실행이 그보다 오래 걸릴 수 있게 된 뒤로는 필수다.
            { timezone: 'Etc/UTC', noOverlap: true },
        ),
    );
}
