import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getCronRuns, getCronDecisions } from '../lib/db/queries.js';

const VALID_CRON_TYPES = new Set([
    'technical',
    'news',
    'options',
    'fundamental',
    'execute',
    'reconcile',
]);

const VALID_STATUSES = new Set(['running', 'completed', 'skipped', 'error']);

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });

    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const url = new URL(req.url);
    const runId = url.searchParams.get('runId');

    if (runId) {
        const decisions = await getCronDecisions(db, runId);
        return Response.json({ decisions });
    }

    const typeParam = url.searchParams.get('type') ?? undefined;
    const statusParam = url.searchParams.get('status') ?? undefined;
    const fromParam = url.searchParams.get('from') ?? undefined;
    const toParam = url.searchParams.get('to') ?? undefined;
    const limitParam = url.searchParams.get('limit') ?? undefined;

    // Validate type — ignore unknown values (don't 400, just skip the filter)
    const cronType = typeParam && VALID_CRON_TYPES.has(typeParam) ? typeParam : undefined;

    // Validate status — ignore unknown values (don't 400, just skip the filter)
    const status = statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined;

    // Parse from/to as ISO date strings — ignore if invalid
    let from: Date | undefined;
    if (fromParam) {
        const d = new Date(fromParam);
        if (!isNaN(d.getTime())) from = d;
    }
    let to: Date | undefined;
    if (toParam) {
        const d = new Date(toParam);
        if (!isNaN(d.getTime())) to = d;
    }

    let limit: number | undefined;
    if (limitParam) {
        const parsed = parseInt(limitParam, 10);
        if (!Number.isNaN(parsed) && parsed > 0) limit = parsed;
    }

    const runs = await getCronRuns(db, { cronType, status, from, to, limit });
    return Response.json({ runs });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
