import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';

export async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }
    const sql = neon(process.env.DATABASE_URL);
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migration complete');
}

// Only auto-execute when run directly as a script
if (process.argv[1]?.endsWith('migrate.ts')) {
    main().catch(console.error);
}
