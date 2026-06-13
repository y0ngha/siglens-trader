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
    // Fallback path (env NOT configured)
    // -----------------------------------------------------------------------

    describe('fallback: header trust when CF Access env vars not configured', () => {
        beforeEach(() => {
            vi.stubEnv('DISABLE_AUTH', '');
            vi.stubEnv('VERCEL_ENV', '');
            vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
            vi.stubEnv('CF_ACCESS_AUD', '');
        });

        it('returns true when cf-access-authenticated-user-email header is present', async () => {
            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(
                makeRequest({ 'cf-access-authenticated-user-email': 'user@example.com' }),
            );
            expect(result).toBe(true);
        });

        it('returns false when cf-access-authenticated-user-email header is absent', async () => {
            const { isAuthenticated: auth } = await import('../auth');
            const result = await auth(makeRequest());
            expect(result).toBe(false);
        });

        it('emits a console.warn in fallback mode', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { isAuthenticated: auth } = await import('../auth');
            await auth(makeRequest());

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('CF Access JWT verification not configured'),
            );
            warnSpy.mockRestore();
        });

        it('emits the fallback console.warn only once across multiple requests (Fix 6)', async () => {
            // vi.resetModules() in afterEach resets module scope so fallbackWarned starts false.
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const { isAuthenticated: auth } = await import('../auth');
            await auth(makeRequest());
            await auth(makeRequest());
            await auth(makeRequest());

            // warn should be emitted exactly once no matter how many requests arrive
            expect(warnSpy).toHaveBeenCalledTimes(1);
            warnSpy.mockRestore();
        });

        it('does NOT call jwtVerify in fallback mode', async () => {
            const { isAuthenticated: auth } = await import('../auth');
            await auth(makeRequest({ 'cf-access-authenticated-user-email': 'user@example.com' }));
            expect(mockJwtVerify).not.toHaveBeenCalled();
        });
    });
});
