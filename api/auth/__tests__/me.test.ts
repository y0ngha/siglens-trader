import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSessionUser = vi.fn();
vi.mock('../../_lib/auth', () => ({
    getSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
}));

import { GET as me } from '../me';

const makeRequest = (method = 'GET') => new Request('https://example.com/api/auth/me', { method });

describe('GET /api/auth/me', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects non-GET methods', async () => {
        expect((await me(makeRequest('POST'))).status).toBe(405);
    });

    it('returns the session user', async () => {
        const user = { id: 'user-1', email: 'operator@example.com', name: null };
        mockGetSessionUser.mockResolvedValue(user);

        const res = await me(makeRequest());
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ user });
    });

    it('401s without a session, so the dashboard falls back to the login form', async () => {
        mockGetSessionUser.mockResolvedValue(null);
        expect((await me(makeRequest())).status).toBe(401);
    });
});
