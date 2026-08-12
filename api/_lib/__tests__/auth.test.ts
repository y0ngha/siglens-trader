import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// jose mock — must be hoisted before the module under test is loaded.
// ---------------------------------------------------------------------------

const mockJwtVerify = vi.fn();
const mockCreateRemoteJWKSet = vi.fn();

vi.mock('jose', () => ({
    jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
    createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
}));

const mockResolveSessionUser = vi.fn();
const FAKE_DB = Symbol('fake-db');
const SESSION_USER = { id: 'user-1', email: 'operator@example.com', name: null };

vi.mock('../../../lib/auth/session.js', () => ({
    resolveSessionUser: (...args: unknown[]) => mockResolveSessionUser(...args),
}));

vi.mock('../db.js', () => ({
    getDb: () => FAKE_DB,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com', { headers });
}

const TEAM_DOMAIN = 'https://myteam.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';
const FAKE_JWKS = Symbol('fake-jwks');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isAuthenticated', () => {
    beforeEach(() => {
        // Reset the module-scope JWKS cache between tests by resetting the mock
        // (each call to createRemoteJWKSet re-caches — we clear it via vi.resetModules
        // in the suite that cares, or by resetting the mock return value).
        mockCreateRemoteJWKSet.mockReturnValue(FAKE_JWKS);
        mockJwtVerify.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    // -----------------------------------------------------------------------
    // DISABLE_AUTH guard (Medium fix)
    // -----------------------------------------------------------------------

    describe('DISABLE_AUTH guard', () => {
        it('returns true when DISABLE_AUTH=true and not in production (NODE_ENV)', async () => {
            vi.stubEnv('DISABLE_AUTH', 'true');
            vi.stubEnv('NODE_ENV', 'development');
            vi.stubEnv('VERCEL_ENV', '');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest());
            expect(result).toBe(true);
        });

        it('returns true when DISABLE_AUTH=true and VERCEL_ENV=preview (non-production)', async () => {
            vi.stubEnv('DISABLE_AUTH', 'true');
            vi.stubEnv('VERCEL_ENV', 'preview');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest());
            expect(result).toBe(true);
        });

        it('ignores DISABLE_AUTH=true when VERCEL_ENV=production (Medium fix)', async () => {
            vi.stubEnv('DISABLE_AUTH', 'true');
            vi.stubEnv('VERCEL_ENV', 'production');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');

            const { isAuthenticated: auth } = await import('../auth');
            // No CF header, no JWT env → falls back to header trust → false
            const result = await auth(makeRequest());
            expect(result).toBe(false);
        });

        it('ignores DISABLE_AUTH=true when NODE_ENV=production and VERCEL_ENV unset', async () => {
            vi.stubEnv('DISABLE_AUTH', 'true');
            vi.stubEnv('NODE_ENV', 'production');
            vi.stubEnv('VERCEL_ENV', '');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest());
            expect(result).toBe(false);
        });

        it('does not short-circuit when DISABLE_AUTH is not "true"', async () => {
            vi.stubEnv('DISABLE_AUTH', 'false');
            vi.stubEnv('VERCEL_ENV', 'development');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');

            const { isAuthenticated: auth } = await import('../auth');
            // Falls through to header fallback — no header → false
            const result = await auth(makeRequest());
            expect(result).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // JWT verification path (env configured)
    // -----------------------------------------------------------------------

    describe('JWT verification (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD configured)', () => {
        beforeEach(() => {
            vi.stubEnv('DISABLE_AUTH', '');
            vi.stubEnv('VERCEL_ENV', '');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM_DOMAIN);
            vi.stubEnv('CF_ACCESS_AUD', AUDIENCE);
            vi.stubEnv('CF_ACCESS_ALLOWED_EMAILS', '');
        });

        it('returns false when Cf-Access-Jwt-Assertion header is absent', async () => {
            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest());
            expect(result).toBe(false);
            expect(mockJwtVerify).not.toHaveBeenCalled();
        });

        it('returns true when JWT is valid and no allowlist is set', async () => {
            mockJwtVerify.mockResolvedValue({ payload: { email: 'user@example.com' } });

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'Cf-Access-Jwt-Assertion': 'valid.jwt.token' }),
            );
            expect(result).toBe(true);
            expect(mockJwtVerify).toHaveBeenCalledWith(
                'valid.jwt.token',
                FAKE_JWKS,
                expect.objectContaining({ issuer: TEAM_DOMAIN, audience: AUDIENCE }),
            );
        });

        it('returns false when jwtVerify throws (tampered/expired JWT)', async () => {
            mockJwtVerify.mockRejectedValue(new Error('JWTExpired'));

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'Cf-Access-Jwt-Assertion': 'tampered.jwt.token' }),
            );
            expect(result).toBe(false);
        });

        it('logs console.error when jwtVerify throws (Fix 2)', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const jwtErr = new Error('JWTExpired');
            mockJwtVerify.mockRejectedValue(jwtErr);

            const { isAuthenticated: auth } = await import('../auth');
            await auth(makeRequest({ 'Cf-Access-Jwt-Assertion': 'tampered.jwt.token' }));

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('[auth] JWT verification failed:'),
                jwtErr,
            );
            errorSpy.mockRestore();
        });

        it('returns false when jwtVerify throws a JWKS fetch error (fail-closed)', async () => {
            mockJwtVerify.mockRejectedValue(new Error('Failed to fetch JWKS'));

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest({ 'Cf-Access-Jwt-Assertion': 'some.jwt.token' }));
            expect(result).toBe(false);
        });

        it('returns true when email is in the allowlist', async () => {
            vi.stubEnv('CF_ACCESS_ALLOWED_EMAILS', 'allowed@example.com,other@example.com');
            mockJwtVerify.mockResolvedValue({ payload: { email: 'allowed@example.com' } });

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'Cf-Access-Jwt-Assertion': 'valid.jwt.token' }),
            );
            expect(result).toBe(true);
        });

        it('returns false when email is NOT in the allowlist', async () => {
            vi.stubEnv('CF_ACCESS_ALLOWED_EMAILS', 'allowed@example.com');
            mockJwtVerify.mockResolvedValue({ payload: { email: 'intruder@evil.com' } });

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'Cf-Access-Jwt-Assertion': 'valid.jwt.token' }),
            );
            expect(result).toBe(false);
        });

        it('returns false when payload has no email claim and allowlist is set', async () => {
            vi.stubEnv('CF_ACCESS_ALLOWED_EMAILS', 'allowed@example.com');
            mockJwtVerify.mockResolvedValue({ payload: {} }); // no email in payload

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'Cf-Access-Jwt-Assertion': 'valid.jwt.token' }),
            );
            expect(result).toBe(false);
        });

        it('uses cached JWKS set (createRemoteJWKSet called once per module load)', async () => {
            // Reset module cache so we get a fresh module with jwks=null.
            vi.resetModules();
            // Re-register the jose mock after resetModules.
            vi.doMock('jose', () => ({
                jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
                createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
            }));
            mockCreateRemoteJWKSet.mockClear();
            mockJwtVerify.mockResolvedValue({ payload: { email: 'user@example.com' } });

            const { isAuthenticated: auth } = await import('../auth');

            await auth(makeRequest({ 'Cf-Access-Jwt-Assertion': 'token1' }));
            await auth(makeRequest({ 'Cf-Access-Jwt-Assertion': 'token2' }));

            // JWKS set should be created only once (module-scope cache)
            expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
            expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
                new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Session cookie path
    // -----------------------------------------------------------------------

    describe('session cookie', () => {
        beforeEach(() => {
            vi.stubEnv('DISABLE_AUTH', '');
            vi.stubEnv('VERCEL_ENV', '');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');
            mockResolveSessionUser.mockReset();
        });

        it('returns true for a cookie that resolves to a user', async () => {
            mockResolveSessionUser.mockResolvedValue(SESSION_USER);

            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest({ cookie: 'trader_session=abc-123' }));

            expect(result).toBe(true);
            expect(mockResolveSessionUser).toHaveBeenCalledWith(FAKE_DB, 'abc-123');
        });

        it('returns false when the cookie is absent', async () => {
            const { isAuthenticated: auth } = await import('../auth');

            expect(await auth(makeRequest())).toBe(false);
            expect(mockResolveSessionUser).not.toHaveBeenCalled();
        });

        it('returns false when the session is unknown or expired', async () => {
            mockResolveSessionUser.mockResolvedValue(null);

            const { isAuthenticated: auth } = await import('../auth');
            expect(await auth(makeRequest({ cookie: 'trader_session=stale' }))).toBe(false);
        });

        it('fails closed (and logs) when the session lookup throws', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockResolveSessionUser.mockRejectedValue(new Error('connection refused'));

            const { isAuthenticated: auth } = await import('../auth');
            expect(await auth(makeRequest({ cookie: 'trader_session=abc-123' }))).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('[auth] session lookup failed:'),
                expect.any(Error),
            );
            errorSpy.mockRestore();
        });

        it('never trusts a bare cf-access-authenticated-user-email header', async () => {
            // The origin is reachable without Access once it is switched off, so a
            // forged header must not be an authentication bypass.
            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'cf-access-authenticated-user-email': 'intruder@evil.com' }),
            );
            expect(result).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // getSessionUser
    // -----------------------------------------------------------------------

    describe('getSessionUser', () => {
        beforeEach(() => {
            mockResolveSessionUser.mockReset();
        });

        it('returns the resolved user', async () => {
            mockResolveSessionUser.mockResolvedValue(SESSION_USER);

            const { getSessionUser } = await import('../auth');
            await expect(
                getSessionUser(makeRequest({ cookie: 'trader_session=abc-123' })),
            ).resolves.toEqual(SESSION_USER);
        });

        it('ignores DISABLE_AUTH — an identity cannot be faked into existence', async () => {
            vi.stubEnv('DISABLE_AUTH', 'true');
            vi.stubEnv('NODE_ENV', 'development');

            const { getSessionUser } = await import('../auth');
            await expect(getSessionUser(makeRequest())).resolves.toBeNull();
        });
    });
});
