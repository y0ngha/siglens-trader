import { getDb } from './_lib/db.js';
import { checkConsistency } from '../lib/db/recovery.js';

async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
        return new Response(null, { status: 405 });
    }

    const url = new URL(req.url, 'http://localhost');
    const base = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
    };

    // Optional deep check: /api/health?deep=true
    if (url.searchParams.get('deep') === 'true') {
        try {
            const db = getDb();
            const consistency = await checkConsistency(db);
            return Response.json({ ...base, consistency });
        } catch (err) {
            return Response.json(
                { ...base, status: 'degraded', error: String(err) },
                { status: 503 },
            );
        }
    }

    // No auth required — this is for uptime monitoring
    return Response.json(base);
}

// Vercel Node runtime: named HTTP-method exports use the Web `Request`/`Response`
// signature. A bare `export default` is treated as the legacy `(req, res)` handler
// (req.headers.get is undefined, returned Response ignored), and its presence forces
// legacy mode even when named exports exist — so we expose ONLY named methods.
export const GET = handler;
