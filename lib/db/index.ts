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
    // 상주 서버라 요청이 동시에 들어온다 — SPA·API·크론이 한 프로세스에 있고 분석 cron은
    // 심볼을 병렬로 돈다. `max: 1`은 "서버리스 인스턴스는 요청을 하나씩 처리한다"는 전제로
    // 붙어 있었는데 EC2 전환으로 그 전제가 깨졌고, 그 상태에서 `db.transaction()`이 단일
    // 커넥션을 잡으면 다른 모든 쿼리가 직렬로 밀려 실행 데드라인·락 TTL을 압박한다.
    // 10은 Neon 커넥션 한도에 비해 여유롭다(인스턴스 1대).
    const pool = new Pool({ connectionString: url, max: 10 });
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
