import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as readline from 'node:readline';

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
    console.warn('           positions, trades, pending_orders, config, notification_config\n');

    const confirmed = await confirm('Are you sure? (Y/n): ');
    if (!confirmed) {
        console.log('Cancelled.');
        return;
    }

    const client = neon(process.env.DATABASE_URL);
    const db = drizzle(client);

    const tables = [
        'analysis_results',
        'trades',
        'pending_orders',
        'positions',
        'watchlist',
        'analysis_model_config',
        'notification_config',
        'config',
    ];

    for (const table of tables) {
        await db.execute(sql.raw(`DELETE FROM ${table}`));
        console.log(`  Cleared: ${table}`);
    }

    console.log('\n✅ All tables cleared.');
}

if (process.argv[1]?.endsWith('clear.ts')) {
    clear().catch((err) => {
        console.error('Clear failed:', err);
        process.exit(1);
    });
}
