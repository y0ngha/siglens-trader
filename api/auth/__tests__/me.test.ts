import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above const declarations, so anything the factory closes over has
// to come from vi.hoisted.
const { mockGetSessionUser, mockIsAuthDisabled, DEV_BYPASS_USER } = vi.hoisted(() => ({
    mockGetSessionUser: vi.fn(),
    mockIsAuthDisabled: vi.fn<() => boolean>(),
    DEV_BYPASS_USER: { id: 'disable-auth-dev', email: 'dev@localhost', name: 'DISABLE_AUTH' },
}));

vi.mock('../../_lib/auth', () => ({
    getSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
    isAuthDisabled: () => mockIsAuthDisabled(),
    DEV_BYPASS_USER,
}));

import { GET as me } from '../me';

const makeRequest = (method = 'GET') => new Request('https://example.com/api/auth/me', { method });

describe('GET /api/auth/me', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsAuthDisabled.mockReturnValue(false);
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

    it('hands back a stand-in user under DISABLE_AUTH so local dev can get past the gate', async () => {
        mockGetSessionUser.mockResolvedValue(null);
        mockIsAuthDisabled.mockReturnValue(true);

        const res = await me(makeRequest());
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ user: DEV_BYPASS_USER });
    });

    it('prefers a real session over the DISABLE_AUTH stand-in', async () => {
        const user = { id: 'user-1', email: 'operator@example.com', name: null };
        mockGetSessionUser.mockResolvedValue(user);
        mockIsAuthDisabled.mockReturnValue(true);

        await expect((await me(makeRequest())).json()).resolves.toEqual({ user });
    });
});
