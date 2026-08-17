import { serve } from '@hono/node-server';
import { app, drainCron, startCron } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, ({ port }) =>
    console.log(`[server] listening on :${port}`),
);
const tasks = startCron();

// Graceful shutdown: stop firing new cron ticks, wait for the in-flight ones, then drain
// HTTP and exit. `task.stop()`은 다음 틱만 막는다 — 실행 중인 틱을 기다리지 않으면
// 주문은 브로커에 나갔는데 booking 트랜잭션 전에 프로세스가 죽는 창이 열린다.
function shutdown(signal: string) {
    console.log(`[server] ${signal} — shutting down`);
    for (const task of tasks) task.stop();
    // 하드 캡보다 짧게 잡아 배수 뒤에 HTTP 종료가 실제로 일어날 시간을 남긴다.
    void drainCron(20_000).finally(() => server.close(() => process.exit(0)));
    // Hard cap so a stuck connection can't block exit past the container stop grace.
    setTimeout(() => process.exit(0), 25_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
