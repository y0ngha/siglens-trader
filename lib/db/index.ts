import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export function createDb() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const sql = neon(url);
    return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
