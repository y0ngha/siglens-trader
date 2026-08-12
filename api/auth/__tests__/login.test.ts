import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeDb = { __db: true };
vi.mock('../../_lib/db', () => ({ getDb: () => fakeDb }));

const mockAuthenticate = vi.fn();
vi.mock('../../../lib/auth/session', () => ({
    authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}));

import { POST as login } from '../login';
import { MAX_FAILED_ATTEMPTS, resetThrottle } from '../../../lib/auth/throttle';

const IP = '203.0.113.7';

function makeRequest(body: unknown, method = 'POST'): Request {
    return new Request('https://example.com/api/auth/login', {
        method,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
}

const SUCCESS = {
    user: { id: 'user-1', email: 'operator@example.com', name: null },
    sessionId: 'session-1',
};

describe('POST /api/auth/login', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetThrottle();
    });

    it('rejects non-POST methods', async () => {
        const res = await login(makeRequest(null, 'GET'));
        expect(res.status).toBe(405);
    });

    it('400s on a malformed body', async () => {
        const res = await login(
            new Request('https://example.com/api/auth/login', { method: 'POST', body: 'not json' }),
        );
        expect(res.status).toBe(400);
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('400s when a field is missing or the wrong type', async () => {
        expect((await login(makeRequest({ email: 'a@b.c' }))).status).toBe(400);
        expect((await login(makeRequest({ email: 'a@b.c', password: 123 }))).status).toBe(400);
        expect((await login(makeRequest({ email: '', password: 'x' }))).status).toBe(400);
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('sets an HttpOnly session cookie on success', async () => {
        mockAuthenticate.mockResolvedValue(SUCCESS);

        const res = await login(makeRequest({ email: 'operator@example.com', password: 'secret' }));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ user: SUCCESS.user });
        const cookie = res.headers.get('set-cookie') ?? '';
        expect(cookie).toContain('trader_session=session-1');
        expect(cookie).toContain('HttpOnly');
        expect(mockAuthenticate).toHaveBeenCalledWith(fakeDb, 'operator@example.com', 'secret');
    });

    it('401s with a message that does not reveal whether the account exists', async () => {
        mockAuthenticate.mockResolvedValue(null);

        const res = await login(makeRequest({ email: 'ghost@example.com', password: 'secret' }));

        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toBeNull();
        await expect(res.json()).resolves.toEqual({
            error: '이메일 또는 비밀번호가 올바르지 않습니다.',
        });
    });

    it('503s and logs when the database is unreachable — not a silent 500', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockAuthenticate.mockRejectedValue(new Error('connection refused'));

        const res = await login(makeRequest({ email: 'operator@example.com', password: 'x' }));

        expect(res.status).toBe(503);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[auth] login failed:'),
            expect.any(Error),
        );
        errorSpy.mockRestore();
    });

    it('429s after too many failures and stops hitting the database', async () => {
        mockAuthenticate.mockResolvedValue(null);
        const body = { email: 'operator@example.com', password: 'wrong' };

        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
            expect((await login(makeRequest(body))).status).toBe(401);
        }
        mockAuthenticate.mockClear();

        const res = await login(makeRequest(body));
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('clears the throttle once the correct password arrives', async () => {
        mockAuthenticate.mockResolvedValue(null);
        const body = { email: 'operator@example.com', password: 'wrong' };
        for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) await login(makeRequest(body));

        mockAuthenticate.mockResolvedValue(SUCCESS);
        expect((await login(makeRequest(body))).status).toBe(200);

        mockAuthenticate.mockResolvedValue(null);
        expect((await login(makeRequest(body))).status).toBe(401);
    });
});
