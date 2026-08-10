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

type WebHandler = (req: Request) => Promise<Response>;

/** Forward Hono's raw Request straight to a Web-standard api/ handler. */
const fwd = (h: WebHandler) => (c: { req: { raw: Request } }) => h(c.req.raw);

/**
 * The 6 scheduled jobs, carried over from the former `vercel.json` crons. Schedules are UTC;
 * the app's own `isEtRegularSessionOpen` gate narrows execution to the US session. Double
 * execution across instances is prevented by the existing Redis SETNX lock (lib/lock.ts).
 */
export const CRON_JOBS: ReadonlyArray<{ name: string; schedule: string; handler: WebHandler }> = [
    { name: 'technical', schedule: '0 13-21 * * 1-5', handler: cronTechnical },
    { name: 'news', schedule: '0 13-21 * * 1-5', handler: cronNews },
    { name: 'options', schedule: '0 13-21 * * 1-5', handler: cronOptions },
    { name: 'fundamental', schedule: '0 15 * * 1-5', handler: cronFundamental },
    // Congressional disclosures lag the actual trade by weeks, so once per weekday is plenty —
    // hourly would just burn LLM calls on data that won't have changed since the last run.
    { name: 'congress', schedule: '0 16 * * 1-5', handler: cronCongress },
    { name: 'execute', schedule: '7 13-21 * * 1-5', handler: cronExecute },
    { name: 'reconcile', schedule: '*/10 13-21 * * 1-5', handler: cronReconcile },
];

export const app = new Hono();

// Whole-site noindex (trader is a private, CF-Access-gated tool) — was a vercel.json header rule.
app.use('*', async (c, next) => {
    await next();
    c.header('X-Robots-Tag', 'noindex, nofollow');
});

app.get('/api/health', fwd(healthGET));
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
