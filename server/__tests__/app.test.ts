// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { app, CRON_JOBS, startCron } from '../app.js';

describe('CRON_JOBS', () => {
    it('keeps the 8 cron schedules with technical/options on 15-min ticks (UTC)', () => {
        expect(CRON_JOBS.map((j) => [j.name, j.schedule])).toEqual([
            ['technical', '*/15 13-21 * * 1-5'],
            // 창(60분)당 틱을 여러 개 둔다 — 하나를 놓쳐도 그 창을 잃지 않는다.
            // 케이던스 가드가 runner 호출 전에 스킵하므로 잉여 틱의 쿼터 비용은 0이다.
            ['news', '*/15 13-21 * * 1-5'],
            ['options', '*/15 13-21 * * 1-5'],
            ['fundamental', '0 15-21 * * 1-5'],
            ['congress', '0 16-21 * * 1-5'],
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

describe('startCron', () => {
    const originalSecret = process.env.CRON_SECRET;
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
        if (originalSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = originalSecret;
        process.env.NODE_ENV = originalEnv;
    });

    it('프로덕션에서 CRON_SECRET이 없으면 부팅을 실패시킨다', () => {
        // 종전에는 경고만 남기고 빈 배열을 돌려줬다 — 매매·정산·분석 크론이 하나도 돌지
        // 않는데 헬스체크는 200이라 배포가 성공으로 기록되고, 침묵을 감시하는 cron-health는
        // digest 크론이 돌아야 동작하므로 경보도 없다.
        delete process.env.CRON_SECRET;
        process.env.NODE_ENV = 'production';

        expect(() => startCron()).toThrow(/CRON_SECRET/);
    });

    it('개발 환경에서는 경고만 남기고 진행한다', () => {
        delete process.env.CRON_SECRET;
        process.env.NODE_ENV = 'test';

        expect(startCron()).toEqual([]);
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
