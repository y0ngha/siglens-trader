import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { checkConsistency } from '../lib/db/recovery.js';

async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
        return new Response(null, { status: 405 });
    }

    const url = new URL(req.url, 'http://localhost');
    const base = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        // 이미지 빌드가 심는 값. 없으면 'unknown' — "포트가 열렸다" 말고 **어떤 빌드가
        // 도는지**를 배포 후 확인할 수 있어야 한다. 하드코딩된 '0.1.0'은 실제 버전과
        // 무관해서 그 확인을 못 했다.
        version: process.env.APP_VERSION ?? 'unknown',
    };

    // Optional deep check: /api/health?deep=true
    if (url.searchParams.get('deep') === 'true') {
        // 얕은 헬스체크만 무인증이다. deep은 `order_tracking`/`trades`를 훑어 심볼·주문키가
        // 담긴 정합성 알림 문자열을 그대로 돌려주고, 반복 호출이 그대로 DB 부하가 된다.
        if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
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
