import { getDb } from '../_lib/db.js';
import { serializeSessionCookie } from '../../lib/auth/cookie.js';
import { authenticate } from '../../lib/auth/session.js';
import {
    clearFailures,
    clientKey,
    isThrottled,
    recordFailure,
    retryAfterSeconds,
} from '../../lib/auth/throttle.js';

/** Single message for every credential failure — never reveal whether the email exists. */
const INVALID_CREDENTIALS = '이메일 또는 비밀번호가 올바르지 않습니다.';

async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const key = clientKey(req);
    if (isThrottled(key)) {
        return Response.json(
            { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
            { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(key)) } },
        );
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { email, password } = (body ?? {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return Response.json({ error: '이메일과 비밀번호를 입력해 주세요.' }, { status: 400 });
    }

    let result: Awaited<ReturnType<typeof authenticate>>;
    try {
        result = await authenticate(getDb(), email, password);
    } catch (err) {
        // Surface the cause the way the other auth routes do — a silent 500 here reads
        // as "wrong password" to the operator and hides a database outage.
        console.error('[auth] login failed:', err);
        return Response.json(
            { error: '로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
            { status: 503 },
        );
    }

    if (!result) {
        recordFailure(key);
        return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    }

    clearFailures(key);
    return Response.json(
        { user: result.user },
        { headers: { 'Set-Cookie': serializeSessionCookie(result.sessionId) } },
    );
}

export const POST = handler;
