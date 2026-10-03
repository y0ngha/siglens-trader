import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { buildPoolConfig } from './connection-config.js';
import * as schema from './schema.js';

// node-postgres(`pg`) Pool이 일반 Postgres 와이어 프로토콜을 쓰므로 인터랙티브 트랜잭션
// (`db.transaction()`)이 그대로 되고, Neon·RDS 어디에나 붙는다. 결과 객체는 `{ rows, rowCount }`
// 형태라 `queries.ts`의 `rowCount` 판정도 그대로 유효하다. TLS 처리는 `connection-config.ts`.

export function createDb() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    // 상주 서버라 요청이 동시에 들어온다 — SPA·API·크론이 한 프로세스에 있고 분석 cron은
    // 심볼을 병렬로 돈다. `max: 1`은 "서버리스 인스턴스는 요청을 하나씩 처리한다"는 전제로
    // 붙어 있었는데 EC2 전환으로 그 전제가 깨졌고, 그 상태에서 `db.transaction()`이 단일
    // 커넥션을 잡으면 다른 모든 쿼리가 직렬로 밀려 실행 데드라인·락 TTL을 압박한다.
    // 10은 DB 커넥션 한도(Neon·RDS 모두)에 비해 여유롭다(인스턴스 1대).
    const pool = new Pool({ ...buildPoolConfig(url), max: 10 });
    // 서버가 연결을 끊으면(DB 재시작·failover·네트워크 순단) 클라이언트는 진행 중 쿼리를 모두 실패시킨 뒤
    // 'error'를 낸다. 리스너가 없으면 Node가 그 이벤트를 다시 던져 프로세스가 통째로 죽는다 — 2026-09-24 18:57Z
    // 장중에 "Connection terminated unexpectedly"로 컨테이너가 재시작됐다. 리스너는 두 곳에 필요하다.
    // - 클라이언트: Pool은 클라이언트를 내줄 때(`db.transaction()` 등) 자기 리스너를 떼고 반납 때 다시 붙인다.
    //   꺼내 쓰는 동안 끊기면 Pool 쪽 리스너로는 못 막으므로, 새 연결마다('connect') 영구 리스너를 단다.
    // - Pool: 쉬는 클라이언트의 오류는 Pool의 'error'로 다시 던져진다. 기록은 클라이언트 리스너가 했으니 삼킨다.
    // 진행 중 쿼리의 오류는 원래대로 호출자가 받고, 끊긴 클라이언트(`_queryable = false`)는 반납 때 Pool이 버린다.
    pool.on('connect', (client: PoolClient) => {
        client.on('error', (err: Error) => {
            console.error('[db] pool client connection error:', err.message);
        });
    });
    pool.on('error', () => {});
    return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Minimal interface shared by both `Db` (NodePgDatabase, node-postgres) and the
 * transaction context (`tx`) returned by `db.transaction()`.
 *
 * Both expose `.insert()`, `.update()`, `.delete()`, `.select()` with
 * the same signatures, so query helpers can accept either without a
 * cast. We use structural typing (Pick) rather than trying to name
 * the transaction's concrete generic parameters.
 */
export type DbOrTx = Pick<Db, 'insert' | 'update' | 'delete' | 'select' | 'execute'>;

export { schema };
