import { isAuthenticated } from '../_lib/auth.js';

async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    let body: { symbol?: string };
    try {
        body = (await req.json()) as { symbol?: string };
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!body.symbol || typeof body.symbol !== 'string') {
        return Response.json({ error: 'Missing symbol' }, { status: 400 });
    }

    // Stub: In production, this would call runTechnicalAnalysis etc. via siglens-core + worker.
    // For now, acknowledge the trigger request.
    return Response.json({ success: true, message: `Analysis triggered for ${body.symbol}` });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const POST = handler;
