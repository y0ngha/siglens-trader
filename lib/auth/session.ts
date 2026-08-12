import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import { SESSION_TTL_SECONDS } from './cookie.js';
import { verifyPassword } from './password.js';

const MS_PER_SECOND = 1000;

/**
 * A genuine cost-12 bcrypt hash of 32 discarded random bytes, used only to spend the
 * same CPU time on a missing account as on a wrong password. It is never a credential
 * and nothing can verify against it.
 *
 * It has to be a *valid* hash: `bcryptjs.compare` against a malformed one returns in
 * ~0 ms instead of ~270 ms, which would leak exactly the timing this is here to hide.
 */
const TIMING_EQUALIZER_HASH = '$2b$12$Bw/GsDWpqVtN3EwiTfWBPO3twbX4.osEHk5GjklDyghPp.TZY.Y5e';

/** The caller identity attached to an authenticated request. */
export interface SessionUser {
    id: string;
    email: string;
    name: string | null;
}

/**
 * Create a session row for `userId` and return its id (the cookie value).
 *
 * Also sweeps that user's expired rows. Login is the natural place for it: rows for
 * sessions that are simply never presented again would otherwise accumulate forever,
 * since {@link resolveSessionUser} only reaps what it is asked about.
 */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<string> {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * MS_PER_SECOND);
    const [row] = await db
        .insert(schema.sessions)
        .values({ userId, expiresAt })
        .returning({ id: schema.sessions.id });

    await db
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.userId, userId), lte(schema.sessions.expiresAt, now)));

    return row.id;
}

/**
 * Resolve a session id to its owner, or null when the session is unknown or
 * expired. An expired row is deleted on the way out; rows never presented again are
 * swept at the owner's next login (see {@link createSession}).
 */
export async function resolveSessionUser(
    db: Db,
    sessionId: string,
    now = new Date(),
): Promise<SessionUser | null> {
    const [row] = await db
        .select({
            expiresAt: schema.sessions.expiresAt,
            id: schema.users.id,
            email: schema.users.email,
            name: schema.users.name,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);

    if (!row) return null;

    if (row.expiresAt.getTime() <= now.getTime()) {
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        return null;
    }

    return { id: row.id, email: row.email, name: row.name };
}

/** Delete a session (logout). Silently no-ops on an unknown id. */
export async function destroySession(db: Db, sessionId: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** Delete every session belonging to a user — used when a password is rotated. */
export async function destroyUserSessions(db: Db, userId: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/**
 * Verify email + password and, on success, open a session.
 *
 * Returns null for every failure mode (unknown email, password-less account,
 * wrong password) so callers cannot distinguish them and leak account existence.
 */
export async function authenticate(
    db: Db,
    email: string,
    password: string,
    now = new Date(),
): Promise<{ user: SessionUser; sessionId: string } | null> {
    const [user] = await db
        .select({
            id: schema.users.id,
            email: schema.users.email,
            name: schema.users.name,
            passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .where(eq(schema.users.email, normalizeEmail(email)))
        .limit(1);

    if (!user?.passwordHash) {
        // Burn one bcrypt verification anyway. Returning early would answer an unknown
        // email hundreds of milliseconds faster than a wrong password, which is exactly
        // the account-existence signal the single error message is meant to hide.
        await verifyPassword(password, TIMING_EQUALIZER_HASH);
        return null;
    }
    if (!(await verifyPassword(password, user.passwordHash))) return null;

    const sessionId = await createSession(db, user.id, now);
    return { user: { id: user.id, email: user.email, name: user.name }, sessionId };
}

/** Lower-case + trim, matching siglens' `normalizeEmail`, so stored emails collate. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
