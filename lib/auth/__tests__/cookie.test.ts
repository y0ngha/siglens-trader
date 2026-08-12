import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    readCookie,
    readSessionCookie,
    serializeClearedSessionCookie,
    serializeSessionCookie,
} from '../cookie';

const makeRequest = (cookie?: string) =>
    new Request('https://example.com', cookie ? { headers: { cookie } } : undefined);

describe('readCookie', () => {
    it('returns null when the request carries no Cookie header', () => {
        expect(readCookie(makeRequest(), SESSION_COOKIE_NAME)).toBeNull();
    });

    it('reads a value from a multi-cookie header', () => {
        const req = makeRequest(`theme=dark; ${SESSION_COOKIE_NAME}=abc-123; other=1`);
        expect(readSessionCookie(req)).toBe('abc-123');
    });

    it('percent-decodes the value', () => {
        expect(readCookie(makeRequest('x=a%20b'), 'x')).toBe('a b');
    });

    it('does not match on a name prefix', () => {
        // `trader_session_backup` must not satisfy a lookup for `trader_session`.
        const req = makeRequest(`${SESSION_COOKIE_NAME}_backup=nope`);
        expect(readSessionCookie(req)).toBeNull();
    });

    it('ignores malformed segments without an "="', () => {
        expect(readCookie(makeRequest(`garbage; x=1`), 'x')).toBe('1');
    });

    it('returns an empty string for a present-but-empty cookie', () => {
        expect(readCookie(makeRequest('x='), 'x')).toBe('');
    });
});

describe('serializeSessionCookie', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('is HttpOnly, SameSite=Lax and scoped to the whole site', () => {
        const cookie = serializeSessionCookie('abc-123');
        expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc-123`);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
        expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    });

    it('adds Secure in production', () => {
        vi.stubEnv('NODE_ENV', 'production');
        expect(serializeSessionCookie('abc-123')).toContain('; Secure');
    });

    it('omits Secure outside production so plain-http dev keeps the cookie', () => {
        vi.stubEnv('NODE_ENV', 'development');
        expect(serializeSessionCookie('abc-123')).not.toContain('Secure');
    });

    it('clears with Max-Age=0 and an epoch expiry', () => {
        const cookie = serializeClearedSessionCookie();
        expect(cookie).toContain('Max-Age=0');
        expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        expect(cookie).toContain('HttpOnly');
    });
});
