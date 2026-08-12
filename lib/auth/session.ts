import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import { SESSION_TTL_SECONDS } from './cookie.js';
import { verifyPassword } from './password.js';

const MS_PER_SECOND = 1000;

/** The caller identity attached to an authenticated request. */
export interface SessionUser {
    id: string;
    email: string;
    name: string | null;
}

/** Create a session row for `userId` and return its id (the cookie value). */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<string> {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * MS_PER_SECOND);
    const [row] = await db
        .insert(schema.sessions)
        .values({ userId, expiresAt })
        .returning({ id: schema.sessions.id });
    return row.id;
}

/**
 * Resolve a session id to its owner, or null when the session is unknown or
 * expired. Expired rows are deleted on the way out so the table cannot grow
 * without bound — no separate reaper job is needed.
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

    if (!user?.passwordHash) return null;
    if (!(await verifyPassword(password, user.passwordHash))) return null;

    const sessionId = await createSession(db, user.id, now);
    return { user: { id: user.id, email: user.email, name: user.name }, sessionId };
}

/** Lower-case + trim, matching siglens' `normalizeEmail`, so stored emails collate. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
