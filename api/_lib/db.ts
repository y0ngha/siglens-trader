import { createDb } from '../../lib/db/index.js';

let _db: ReturnType<typeof createDb> | null = null;

export function getDb() {
    if (!_db) _db = createDb();
    return _db;
}
