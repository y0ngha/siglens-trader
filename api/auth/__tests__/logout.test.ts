import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeDb = { __db: true };
vi.mock('../../_lib/db', () => ({ getDb: () => fakeDb }));

const mockDestroySession = vi.fn();
vi.mock('../../../lib/auth/session', () => ({
    destroySession: (...args: unknown[]) => mockDestroySession(...args),
}));

import { POST as logout } from '../logout';

function makeRequest(cookie?: string, method = 'POST'): Request {
    return new Request('https://example.com/api/auth/logout', {
        method,
        headers: cookie ? { cookie } : undefined,
    });
}

function setCookieOf(res: Response): string {
    return res.headers.get('set-cookie') ?? '';
}

describe('POST /api/auth/logout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDestroySession.mockResolvedValue(undefined);
    });

    it('rejects non-POST methods', async () => {
        expect((await logout(makeRequest(undefined, 'GET'))).status).toBe(405);
    });

    it('revokes the session server-side and clears the cookie', async () => {
        const res = await logout(makeRequest('trader_session=session-1'));

        expect(res.status).toBe(200);
        expect(mockDestroySession).toHaveBeenCalledWith(fakeDb, 'session-1');
        expect(setCookieOf(res)).toContain('Max-Age=0');
    });

    it('still clears the cookie when there is no session to revoke', async () => {
        const res = await logout(makeRequest());

        expect(res.status).toBe(200);
        expect(mockDestroySession).not.toHaveBeenCalled();
        expect(setCookieOf(res)).toContain('Max-Age=0');
    });

    it('clears the cookie even if the delete fails — never strand a logged-in browser', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockDestroySession.mockRejectedValue(new Error('connection refused'));

        const res = await logout(makeRequest('trader_session=session-1'));

        expect(res.status).toBe(200);
        expect(setCookieOf(res)).toContain('Max-Age=0');
        errorSpy.mockRestore();
    });
});
