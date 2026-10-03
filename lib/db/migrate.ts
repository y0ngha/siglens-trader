import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildPoolConfig } from './connection-config.js';

export async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required');
    }
    const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL));
    try {
        const db = drizzle(pool);
        // node-postgres 마이그레이터는 미적용분 전체를 한 트랜잭션으로 실행한다 —
        // 중간에 실패하면 SQL과 적용 기록이 함께 롤백된다.
        await migrate(db, { migrationsFolder: './drizzle' });
        console.log('Migration complete');
    } finally {
        // 풀이 열려 있으면 스크립트 프로세스가 끝나지 않는다.
        await pool.end();
    }
}

/** 실패를 exit code 1로 알린다 — 감싼 스크립트·`&&` 체인이 실패한 마이그레이션을 성공으로 보지 않게. */
export function reportFailure(error: unknown): void {
    console.error(error);
    process.exitCode = 1;
}

// Only auto-execute when run directly as a script
if (process.argv[1]?.endsWith('migrate.ts')) {
    main().catch(reportFailure);
}
