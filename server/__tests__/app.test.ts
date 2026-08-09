// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { app, CRON_JOBS } from '../app.js';

describe('CRON_JOBS', () => {
    it('mirrors the 6 vercel.json cron schedules (UTC)', () => {
        expect(CRON_JOBS.map((j) => [j.name, j.schedule])).toEqual([
            ['technical', '0 13-21 * * 1-5'],
            ['news', '0 13-21 * * 1-5'],
            ['options', '0 13-21 * * 1-5'],
            ['fundamental', '0 15 * * 1-5'],
            ['execute', '7 13-21 * * 1-5'],
            ['reconcile', '*/10 13-21 * * 1-5'],
        ]);
    });

    it('wires a handler function for each job', () => {
        for (const j of CRON_JOBS) expect(typeof j.handler).toBe('function');
    });
});

describe('app routing', () => {
    it('serves GET /api/health', async () => {
        const res = await app.request('/api/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: expect.any(String) });
    });

    it('stamps X-Robots-Tag noindex on responses', async () => {
        const res = await app.request('/api/health');
        expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    });

    it('404s unknown /api paths instead of falling back to the SPA', async () => {
        expect((await app.request('/api/nope')).status).toBe(404);
    });

    it('routes dynamic segments to their handler (403 auth, not 404)', async () => {
        // Handlers parse the id out of their own request URL, so the path must survive forwarding.
        expect((await app.request('/api/approve/123', { method: 'POST' })).status).toBe(403);
        expect((await app.request('/api/positions/45/close', { method: 'POST' })).status).toBe(403);
    });

    it('mounts cron endpoints behind the CRON_SECRET gate (401, not 404)', async () => {
        // No CRON_SECRET in the test env → the handler's own auth rejects with 401,
        // which also proves the route is registered (a missing route would 404).
        const res = await app.request('/api/cron/technical');
        expect(res.status).toBe(401);
    });
});
