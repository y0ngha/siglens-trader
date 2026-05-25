export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
        return new Response(null, { status: 405 });
    }

    // No auth required — this is for uptime monitoring
    return Response.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
    });
}
