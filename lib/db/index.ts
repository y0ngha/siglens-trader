import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

// neon-serverless uses WebSockets for the full wire protocol (enables interactive
// transactions, unlike neon-http). Provide the ws constructor for Node runtimes.
neonConfig.webSocketConstructor = ws;

export function createDb() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    // max:1 — a serverless instance handles one request at a time, so one connection
    // per instance avoids exhausting Neon's connection limit when functions scale out.
    const pool = new Pool({ connectionString: url, max: 1 });
    return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Minimal interface shared by both `Db` (NeonDatabase, neon-serverless) and the
 * transaction context (`tx`) returned by `db.transaction()`.
 *
 * Both expose `.insert()`, `.update()`, `.delete()`, `.select()` with
 * the same signatures, so query helpers can accept either without a
 * cast. We use structural typing (Pick) rather than trying to name
 * the transaction's concrete generic parameters.
 */
export type DbOrTx = Pick<Db, 'insert' | 'update' | 'delete' | 'select' | 'execute'>;

export { schema };
