import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleRoot = resolve(__dirname, '../../../drizzle');

interface JournalEntry {
    idx: number;
    tag: string;
    when: number;
}

const entries: JournalEntry[] = JSON.parse(
    readFileSync(resolve(drizzleRoot, 'meta/_journal.json'), 'utf-8'),
).entries;

/**
 * `drizzle-orm@0.45` 의 neon-http migrator 가 실제로 쓰는 판정식.
 *
 * ```js
 * select ... from drizzle.__drizzle_migrations order by created_at desc limit 1
 * ...
 * if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 * ```
 *
 * 적용 기록 **한 행**(가장 큰 `created_at`)만 읽고, 그보다 큰 `when` 을 가진
 * 것만 실행한다. 해시는 저장만 될 뿐 비교에 쓰이지 않는다.
 *
 * 따라서 `when` 이 앞선 어떤 항목보다도 크지 않으면, 그 마이그레이션은
 * **에러 없이 영원히 건너뛰어진다.** 실패가 아니라 침묵이라 배포는 초록으로
 * 지나가고 스키마만 조용히 어긋난다.
 *
 * 여기서는 기준선을 항목마다 갱신(`highWaterMark`)하지만, 실제 migrator 는
 * 루프 **전에 한 번** 읽고 그 안에서는 갱신하지 않는다. 그래서 한 배포에 새
 * 마이그레이션이 여러 개 들어오고 그들끼리 순서가 뒤집힌 경우, 실제로는 전부
 * 같은 기준선과 비교돼 모두 실행되는데 이 판정은 뒤쪽을 위반으로 본다.
 *
 * 어긋남은 **거짓 양성 한 방향뿐이다** — 갱신하는 기준선은 어느 지점에서나
 * 실제 기준선 이상이므로, 여기를 통과한 항목은 반드시 실행된다. 놓치는 위반은
 * 없다. 그 엄격함을 그대로 둔다: neon-http 는 트랜잭션이 없어 배포가 중간에
 * 죽으면 SQL 만 적용되고 기록 행은 안 남을 수 있고, 그러면 다음 실행의 기준선이
 * 정확히 이 판정이 가정하는 위치에 선다.
 *
 * 이 테스트가 그 경우로 실패하면 제품 결함이 아니라 판정이 보수적인 것이다 —
 * 새 마이그레이션들의 `when` 을 오름차순으로 맞추면 풀린다.
 */
function skippableEntries(list: readonly JournalEntry[]): string[] {
    const offenders: string[] = [];
    let highWaterMark = -Infinity;

    for (const entry of list) {
        if (entry.when <= highWaterMark) offenders.push(entry.tag);
        highWaterMark = Math.max(highWaterMark, entry.when);
    }
    return offenders;
}

/**
 * 이미 저장소에 들어와 있는 위반 2건.
 *
 * 손으로 적은 듯한 정각 밀리초(2025-05-25 / 05-26 00:00 UTC)라 `0000` 보다도
 * 이르다. 운영 DB 는 두 건의 객체가 모두 존재하고 `max(created_at)` 이 이미
 * 그보다 훨씬 위라 지금은 무해하다 — 그래서 저널을 고쳐 과거를 다시 쓰는 대신
 * 여기 기록해 두고, **새로 추가되는 위반만** 막는다.
 */
const GRANDFATHERED = new Set(['0002_create_order_tracking', '0003_add_performance_indexes']);

describe('migration journal', () => {
    it('새 마이그레이션의 `when` 은 앞선 모든 항목보다 커야 한다', () => {
        const offenders = skippableEntries(entries).filter((tag) => !GRANDFATHERED.has(tag));

        expect(offenders).toEqual([]);
    });

    it('알려진 위반 2건이 여전히 그 2건뿐이다', () => {
        // GRANDFATHERED 가 새 위반을 덮어 주는 담요가 되지 않도록, 목록이
        // 실제 위반 집합과 정확히 일치하는지 양방향으로 고정한다.
        expect([...skippableEntries(entries)].sort()).toEqual([...GRANDFATHERED].sort());
    });

    it('판정식이 실제로 건너뜀을 잡아낸다', () => {
        // 가드 자체의 되돌림 검증 — 순서가 뒤집힌 항목을 넣으면 걸려야 한다.
        const rigged: JournalEntry[] = [
            { idx: 0, tag: 'a', when: 200 },
            { idx: 1, tag: 'b', when: 100 },
        ];

        expect(skippableEntries(rigged)).toEqual(['b']);
    });

    it('`idx` 가 배열 위치와 일치한다', () => {
        expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    });

    it('모든 항목에 대응하는 `.sql` 파일이 있다', () => {
        // 파일이 없으면 `readMigrationFiles` 가 읽기 단계에서 죽는다.
        const missing = entries
            .map((e) => e.tag)
            .filter((tag) => !existsSync(resolve(drizzleRoot, `${tag}.sql`)));

        expect(missing).toEqual([]);
    });
});
