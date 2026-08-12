import { eq, sql } from 'drizzle-orm';
import { createDb, schema, type Db } from './index.js';
import { hashPassword } from '../auth/password.js';
import { destroyUserSessions, normalizeEmail } from '../auth/session.js';

/**
 * Provision the operator account and hand it ownership of the existing data.
 *
 * Trader has no signup flow, so accounts are created here. The script is
 * idempotent: re-running it re-hashes the supplied password (a rotation) and
 * re-runs the backfill, which is a no-op once every row is already owned.
 *
 *   OPERATOR_EMAIL=… OPERATOR_PASSWORD=… yarn db:seed-operator
 *
 * The password is read from the environment and never written to the repo.
 */

/**
 * Tables carrying a `user_id` owner column (see `schema.ts`). Each gets its
 * existing rows backfilled and a column DEFAULT pointing at the operator, so
 * the trading and cron insert paths keep working untouched.
 */
const OWNED_TABLES = [
    'watchlist',
    'analysis_model_config',
    'positions',
    'trades',
    'pending_orders',
    'config',
    'order_tracking',
    'notification_config',
] as const;

/** Create the account if absent, otherwise rotate its password. Returns the user id. */
export async function upsertOperator(db: Db, email: string, password: string): Promise<string> {
    const normalized = normalizeEmail(email);
    const passwordHash = await hashPassword(password);

    const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, normalized))
        .limit(1);

    if (existing) {
        await db
            .update(schema.users)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(schema.users.id, existing.id));
        // A rotated password must not leave old cookies working.
        await destroyUserSessions(db, existing.id);
        return existing.id;
    }

    const [created] = await db
        .insert(schema.users)
        .values({ email: normalized, passwordHash, emailVerified: true })
        .returning({ id: schema.users.id });
    return created.id;
}

/**
 * Point every unowned row at `userId` and make it the column DEFAULT.
 *
 * The DEFAULT is what keeps insert sites free of user plumbing while exactly one
 * account exists; drop it (and start passing an explicit owner) when signup lands.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function claimExistingData(db: Db, userId: string): Promise<Record<string, number>> {
    // `ALTER TABLE … SET DEFAULT` is DDL and cannot take a bind parameter, so the id
    // has to be inlined. Validate its shape first rather than interpolating blindly.
    if (!UUID_PATTERN.test(userId)) throw new Error(`Not a uuid: ${userId}`);

    const claimed: Record<string, number> = {};

    for (const table of OWNED_TABLES) {
        const result = await db.execute(
            sql`UPDATE ${sql.identifier(table)} SET user_id = ${userId}::uuid WHERE user_id IS NULL`,
        );
        claimed[table] = result.rowCount ?? 0;
        await db.execute(
            sql.raw(`ALTER TABLE "${table}" ALTER COLUMN user_id SET DEFAULT '${userId}'::uuid`),
        );
    }

    return claimed;
}

export async function main() {
    const email = process.env.OPERATOR_EMAIL;
    const password = process.env.OPERATOR_PASSWORD;
    if (!email || !password) {
        throw new Error('OPERATOR_EMAIL and OPERATOR_PASSWORD are required');
    }

    const db = createDb();
    const userId = await upsertOperator(db, email, password);
    const claimed = await claimExistingData(db, userId);

    console.log(`Operator ready: ${normalizeEmail(email)} (${userId})`);
    for (const [table, rows] of Object.entries(claimed)) {
        console.log(`  ${table}: ${rows} row(s) claimed`);
    }
}

if (process.argv[1]?.endsWith('seed-operator.ts')) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
