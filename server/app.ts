import { Hono } from 'hono';
import type { Context } from 'hono';
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
import { GET as cronTechnical } from '../api/cron/technical.js';
import { GET as cronNews } from '../api/cron/news.js';
import { GET as cronOptions } from '../api/cron/options.js';
import { GET as cronFundamental } from '../api/cron/fundamental.js';
import { GET as cronCongress } from '../api/cron/congress.js';
import { GET as cronExecute } from '../api/cron/execute.js';
import { GET as cronReconcile } from '../api/cron/reconcile.js';
import { GET as cronDigest } from '../api/cron/digest.js';

type WebHandler = (req: Request) => Promise<Response>;

/** Forward Hono's raw Request straight to a Web-standard api/ handler. */
const fwd = (h: WebHandler) => (c: { req: { raw: Request } }) => h(c.req.raw);

/**
 * Scheduled jobs (UTC schedules; `isEtRegularSessionOpen` narrows to the actual US session).
 * Double execution across instances is prevented by the Redis SETNX lock (lib/lock.ts).
 *
 * technical and options tick every 15 minutes so a short configured horizon (15Min/30Min) is
 * actually honored. The cadence guard in `_run-analysis-cron.ts` collapses surplus ticks when
 * the configured horizon is longer — a 1Hour config still produces only one LLM call per hour.
 */
export const CRON_JOBS: ReadonlyArray<{ name: string; schedule: string; handler: WebHandler }> = [
    { name: 'technical', schedule: '*/15 13-21 * * 1-5', handler: cronTechnical },
    // 창(60분)당 틱이 하나뿐이면 그 한 번을 놓칠 때 그 시간대 뉴스 분석이 통째로 없다
    // (락 경합·재시작·DB 일시 오류). 케이던스 가드가 runner **호출 전에** 스킵하므로
    // 잉여 틱의 비용은 심볼당 DB 조회 한 번이고 LLM/FMP 쿼터는 0이다.
    { name: 'news', schedule: '*/15 13-21 * * 1-5', handler: cronNews },
    { name: 'options', schedule: '*/15 13-21 * * 1-5', handler: cronOptions },
    // 하루 1틱이면 그 틱을 놓친 날은 펀더멘털이 없다. 케이던스 창이 24시간이라
    // 그날 첫 성공 이후의 틱은 전부 스킵된다 — 여유 틱은 재시도 창일 뿐이다.
    { name: 'fundamental', schedule: '0 15-21 * * 1-5', handler: cronFundamental },
    // Congressional disclosures lag the actual trade by weeks, so once per weekday is plenty —
    // hourly would just burn LLM calls on data that won't have changed since the last run.
    { name: 'congress', schedule: '0 16-21 * * 1-5', handler: cronCongress },
    // 5분마다 호출하고, 실제 실행 여부는 핸들러 안의 `execute_interval_min` 게이트가 정한다
    // (`lib/strategy/execute-interval.ts`). 스케줄 문자열을 설정으로 바꾸려면 태스크 재등록
    // = 재시작이 필요한데, 게이트는 대시보드에서 바꾼 즉시 다음 틱부터 먹는다.
    // `7-59/5`의 :07 오프셋은 정각에 시작하는 분석 cron 결과가 저장될 시간을 준다 — 간격을
    // 60분으로 두면 종전 `7 13-21` 스케줄과 실행 시각이 분 단위로 같다.
    // `2-59/5`는 매 5분(:02 :07 :12 …)이라 게이트가 인정하는 모든 분을 덮는다. `7-59/5`는
    // :02를 빼먹어 `execute_interval_min = 5`에서 :57 → 다음 시 :07이 10분 공백이 됐다.
    { name: 'execute', schedule: '2-59/5 13-21 * * 1-5', handler: cronExecute },
    { name: 'reconcile', schedule: '*/10 13-21 * * 1-5', handler: cronReconcile },
    // 01:00 UTC = 10:00 KST. Runs daily (including weekends) — there are no day-of-week
    // restrictions because quiet-hours notifications can be queued any day US market trades.
    { name: 'digest', schedule: '0 1 * * *', handler: cronDigest },
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

/**
 * 이미 만들어진 응답에 `Cache-Control`을 얹는다.
 *
 * `c.header()`가 아니라 `c.res` 교체인 이유는 아래 `onFound` 주석 참고 — 응답 객체가
 * `onFound` 호출 전에 생성되므로 헤더 API로는 닿지 않는다.
 */
function setCacheControl(c: Context, value: string): void {
    const headers = new Headers(c.res.headers);
    headers.set('Cache-Control', value);
    c.res = new Response(c.res.body, { status: c.res.status, headers });
}

// 캐시 정책은 **명시한다.** 종전에는 아무 헤더도 붙이지 않아 Cloudflare가 스스로
// 판단했고(자산에 `max-age=14400`), 그 결과 SPA 폴백이 잘못 내려준 HTML 응답까지 4시간
// 캐시됐다 — 서버 결함이 CDN에 각인돼 배포를 해도 낫지 않는 상태가 됐다.
//
// 헤더는 `onFound`에서 **`c.res`를 직접 고쳐** 얹는다. 세 가지 자연스러운 방법이 전부
// 실패한다: (1) 정적 서빙 앞의 `c.header()`는 `serveStatic`이 자체 응답을 만들며 버리고,
// (2) `await next()` 뒤의 사후 처리는 아예 실행되지 않으며(serveStatic이 체인을 끝낸다),
// (3) `onFound` 안의 `c.header()`도 응답 객체가 그 호출 **전에** 이미 만들어져 무시된다.
// `c.res`를 갈아끼우는 것만이 `app.request()`(테스트)와 실제 HTTP 양쪽에서 동작한다.
app.get(
    '/*',
    serveStatic({
        root: './dist',
        onFound: (path, c) => {
            // 파일명에 콘텐츠 해시가 있는 자산만 영구 캐시한다 — 같은 이름이면 같은
            // 내용이므로 안전하고, `immutable`이 재검증까지 없앤다. 나머지(문서·매니페스트)는
            // 캐시하지 않는다.
            setCacheControl(
                c,
                path.includes('/assets/')
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache, must-revalidate',
            );
        },
    }),
);

app.get('/assets/*', (c) => c.notFound());

// SPA 문서는 **절대 캐시하지 않는다.** 이 문서가 어떤 청크를 부를지 결정하므로, 옛
// 문서가 살아 있으면 새 배포의 자산을 영영 못 찾는다 — 청크 로드 실패의 근원이다.
// `/`뿐 아니라 `/positions` 같은 클라이언트 라우트도 같은 문서를 받으므로 여기서 건다.
app.get(
    '/*',
    serveStatic({
        path: './dist/index.html',
        // SPA 문서는 **절대 캐시하지 않는다.** 이 문서가 어떤 청크를 부를지 정하므로,
        // 옛 문서가 살아 있으면 새 배포의 자산을 영영 못 찾는다 — 청크 로드 실패의 근원.
        onFound: (_path, c) => setCacheControl(c, 'no-cache, must-revalidate'),
    }),
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
