// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { app, CRON_JOBS } from '../app.js';

describe('CRON_JOBS', () => {
    it('keeps the 8 cron schedules with technical/options on 15-min ticks (UTC)', () => {
        expect(CRON_JOBS.map((j) => [j.name, j.schedule])).toEqual([
            ['technical', '*/15 13-21 * * 1-5'],
            ['news', '0 13-21 * * 1-5'],
            ['options', '*/15 13-21 * * 1-5'],
            ['fundamental', '0 15 * * 1-5'],
            ['congress', '0 16 * * 1-5'],
            // 5분마다 호출하고 실제 실행 여부는 핸들러의 `execute_interval_min` 게이트가
            // 정한다. :07 오프셋은 종전 `7 13-21`에서 그대로 이어받았다 — 간격 60분이면
            // 실행 시각이 종전과 같다.
            ['execute', '2-59/5 13-21 * * 1-5'],
            ['reconcile', '*/10 13-21 * * 1-5'],
            // Daily, not weekday-only: Friday-night events must reach the operator on
            // Saturday morning. 01:00 UTC = 10:00 KST, just after quiet hours end.
            ['digest', '0 1 * * *'],
        ]);
    });

    it('wires a handler function for each job', () => {
        for (const j of CRON_JOBS) expect(typeof j.handler).toBe('function');
    });

    it('node-cron이 파싱할 수 있는 표현식만 등록한다', async () => {
        // `7-59/5` 같은 step 표현식은 스케줄러가 받아주지 않으면 등록 시점에 터진다.
        const cron = (await import('node-cron')).default;
        for (const j of CRON_JOBS) expect(cron.validate(j.schedule)).toBe(true);
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
