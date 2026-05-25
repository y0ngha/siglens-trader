import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyCronSecret } from '../cron-auth';

describe('verifyCronSecret', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns false when CRON_SECRET is not set', () => {
        vi.stubEnv('CRON_SECRET', '');

        const req = new Request('https://example.com', {
            headers: { authorization: 'Bearer some-secret' },
        });

        expect(verifyCronSecret(req)).toBe(false);
    });

    it('returns true when authorization header matches CRON_SECRET', () => {
        vi.stubEnv('CRON_SECRET', 'my-secret');

        const req = new Request('https://example.com', {
            headers: { authorization: 'Bearer my-secret' },
        });

        expect(verifyCronSecret(req)).toBe(true);
    });

    it('returns false when authorization header does not match CRON_SECRET', () => {
        vi.stubEnv('CRON_SECRET', 'my-secret');

        const req = new Request('https://example.com', {
            headers: { authorization: 'Bearer wrong-secret' },
        });

        expect(verifyCronSecret(req)).toBe(false);
    });

    it('returns false when authorization header is missing', () => {
        vi.stubEnv('CRON_SECRET', 'my-secret');

        const req = new Request('https://example.com');

        expect(verifyCronSecret(req)).toBe(false);
    });

    it('returns false when authorization header has wrong format', () => {
        vi.stubEnv('CRON_SECRET', 'my-secret');

        const req = new Request('https://example.com', {
            headers: { authorization: 'my-secret' },
        });

        expect(verifyCronSecret(req)).toBe(false);
    });
});
