import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as readline from 'node:readline';
import {
    analysisResults,
    trades,
    pendingOrders,
    positions,
    watchlist,
    analysisModelConfig,
    notificationConfig,
    config,
    cronRuns,
    cronDecisions,
} from './schema.js';

async function confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(message, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

export async function clear() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }

    console.warn('\n⚠️  WARNING: This will DELETE ALL DATA from the database.');
    console.warn('   Tables: watchlist, analysis_model_config, analysis_results,');
    console.warn('           positions, trades, pending_orders, config, notification_config,');
    console.warn('           cron_runs, cron_decisions\n');

    const confirmed = await confirm('Are you sure? (Y/n): ');
    if (!confirmed) {
        console.log('Cancelled.');
        return;
    }

    const client = neon(process.env.DATABASE_URL);
    const db = drizzle(client);

    const tablesToClear = [
        { table: cronDecisions, name: 'cron_decisions' },
        { table: cronRuns, name: 'cron_runs' },
        { table: analysisResults, name: 'analysis_results' },
        { table: trades, name: 'trades' },
        { table: pendingOrders, name: 'pending_orders' },
        { table: positions, name: 'positions' },
        { table: watchlist, name: 'watchlist' },
        { table: analysisModelConfig, name: 'analysis_model_config' },
        { table: notificationConfig, name: 'notification_config' },
        { table: config, name: 'config' },
    ] as const;

    for (const { table, name } of tablesToClear) {
        await db.delete(table);
        console.log(`  Cleared: ${name}`);
    }

    console.log('\n✅ All tables cleared.');
}

if (process.argv[1]?.endsWith('clear.ts')) {
    clear().catch((err) => {
        console.error('Clear failed:', err);
        process.exit(1);
    });
}
