import { serve } from '@hono/node-server';
import { app, startCron } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, ({ port }) =>
    console.log(`[server] listening on :${port}`),
);
const tasks = startCron();

// Graceful shutdown: stop firing new cron ticks, then drain in-flight HTTP, then exit.
// (Cron handlers run submit→poll synchronously, so no separate background-task registry.)
function shutdown(signal: string) {
    console.log(`[server] ${signal} — shutting down`);
    for (const task of tasks) task.stop();
    server.close(() => process.exit(0));
    // Hard cap so a stuck connection can't block exit past the container stop grace.
    setTimeout(() => process.exit(0), 25_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
