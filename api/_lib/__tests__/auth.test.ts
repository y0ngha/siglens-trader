import { describe, it, expect, vi, afterEach } from 'vitest';
import { isAuthenticated } from '../auth';

describe('isAuthenticated', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns true when cf-access-authenticated-user-email header is present', () => {
        const req = new Request('https://example.com', {
            headers: { 'cf-access-authenticated-user-email': 'user@example.com' },
        });

        expect(isAuthenticated(req)).toBe(true);
    });

    it('returns true when DISABLE_AUTH=true', () => {
        vi.stubEnv('DISABLE_AUTH', 'true');

        const req = new Request('https://example.com');

        expect(isAuthenticated(req)).toBe(true);
    });

    it('returns false when neither CF header nor DISABLE_AUTH is set', () => {
        vi.stubEnv('DISABLE_AUTH', '');

        const req = new Request('https://example.com');

        expect(isAuthenticated(req)).toBe(false);
    });

    it('returns false when DISABLE_AUTH is set to something other than "true"', () => {
        vi.stubEnv('DISABLE_AUTH', 'false');

        const req = new Request('https://example.com');

        expect(isAuthenticated(req)).toBe(false);
    });
});
