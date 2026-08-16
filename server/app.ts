import { Hono } from 'hono';
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
    { name: 'news', schedule: '0 13-21 * * 1-5', handler: cronNews },
    { name: 'options', schedule: '*/15 13-21 * * 1-5', handler: cronOptions },
    { name: 'fundamental', schedule: '0 15 * * 1-5', handler: cronFundamental },
    // Congressional disclosures lag the actual trade by weeks, so once per weekday is plenty —
    // hourly would just burn LLM calls on data that won't have changed since the last run.
    { name: 'congress', schedule: '0 16 * * 1-5', handler: cronCongress },
    // 5분마다 호출하고, 실제 실행 여부는 핸들러 안의 `execute_interval_min` 게이트가 정한다
    // (`lib/strategy/execute-interval.ts`). 스케줄 문자열을 설정으로 바꾸려면 태스크 재등록
    // = 재시작이 필요한데, 게이트는 대시보드에서 바꾼 즉시 다음 틱부터 먹는다.
    // `7-59/5`의 :07 오프셋은 정각에 시작하는 분석 cron 결과가 저장될 시간을 준다 — 간격을
    // 60분으로 두면 종전 `7 13-21` 스케줄과 실행 시각이 분 단위로 같다.
    { name: 'execute', schedule: '7-59/5 13-21 * * 1-5', handler: cronExecute },
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

// Static SPA: serve built assets, else fall back to index.html (client-side routing).
app.get('/*', serveStatic({ root: './dist' }));
app.get('/*', serveStatic({ path: './dist/index.html' }));

/**
 * Register the cron schedules. Each tick invokes the handler in-process with a synthetic
 * CRON_SECRET-bearing Request so the handler's own auth + logic run unchanged. Returns the
 * tasks so the caller can stop them on shutdown. No-op (warns) if CRON_SECRET is unset.
 */
export function startCron(): ScheduledTask[] {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn('[cron] CRON_SECRET unset — scheduler disabled');
        return [];
    }
    return CRON_JOBS.map(({ name, schedule, handler }) =>
        cron.schedule(
            schedule,
            async () => {
                try {
                    const req = new Request(`http://localhost/api/cron/${name}`, {
                        headers: { authorization: `Bearer ${secret}` },
                    });
                    const res = await handler(req);
                    console.log(`[cron:${name}] ${res.status}`);
                } catch (err) {
                    console.error(`[cron:${name}] failed`, err);
                }
            },
            { timezone: 'Etc/UTC' },
        ),
    );
}
