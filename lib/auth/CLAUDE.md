# lib/auth/ — Application (Authentication)

Password verification, session lifecycle, and login throttling for the dashboard's
own login. There is **no signup** — accounts are provisioned by
`lib/db/seed-operator.ts`.

## Files

| File | Responsibility |
|------|---------------|
| `cookie.ts` | Pure cookie string handling: `readCookie` / `readSessionCookie`, `serializeSessionCookie`, `serializeClearedSessionCookie`, `SESSION_COOKIE_NAME`, `SESSION_TTL_SECONDS`. No I/O. |
| `password.ts` | bcrypt wrapper — `hashPassword` / `verifyPassword` at `BCRYPT_SALT_ROUNDS = 12` |
| `session.ts` | DB-backed session lifecycle: `authenticate`, `createSession`, `resolveSessionUser`, `destroySession`, `destroyUserSessions`, `normalizeEmail`, `isSessionId`, `SessionUser` |
| `throttle.ts` | In-process failed-login counter: `clientKey`, `isThrottled`, `recordFailure`, `clearFailures`, `retryAfterSeconds` |

## Dependency Direction

```
api/auth/, api/_lib/auth.ts → lib/auth/
lib/auth/session.ts → lib/db/ (Db type + schema), lib/auth/{cookie,password}
lib/auth/{cookie,password,throttle} → no project deps (cookie and throttle are pure)
```

`lib/db/seed-operator.ts` imports `lib/auth/{password,session}`. That is the one edge
pointing back from `lib/db/`, and it is inert: `seed-operator.ts` is a CLI entry point
(like `migrate.ts`, `seed.ts`, `clear.ts`) that nothing in the app imports.

## Invariants

1. **Every credential failure returns the same result.** Unknown email, an account with
   no `password_hash`, and a wrong password all yield `null` from `authenticate` — the
   caller cannot tell them apart, and a missing account still burns one bcrypt
   verification (`TIMING_EQUALIZER_HASH`) so response time does not leak existence
   either. The equalizer must stay a *valid* hash: `compare` against a malformed one
   returns in ~0 ms instead of ~270 ms.
2. **bcrypt cost stays at 12.** siglens uses the same algorithm and cost, so operator
   hashes remain verifiable if the two account systems are merged.
3. **`cookie.ts` never throws.** It parses attacker-controlled headers before any auth
   check runs, so a malformed percent-escape falls back to the raw value rather than
   turning into a 500.
4. **Sessions expire on read.** `resolveSessionUser` treats `expiresAt <= now` as
   expired and deletes the row; rows never presented again are swept at the owner's
   next login. There is no reaper cron.
5. **Session ids are uuids, and the shape is checked before any use.** `sessions.id`
   is a uuid column, so a malformed cookie raises `22P02` instead of matching nothing.
   `isSessionId` gates the query *and* `api/_lib/auth.ts`'s session cache, so an
   unauthenticated client cannot spend database round trips, CloudWatch lines, or cache
   slots on junk values.
6. **`throttle.ts` is per-process.** Correct for the single-instance deployment; a
   second app instance would multiply the limit by N and needs a shared counter.

## Related

- `api/_lib/auth.ts` — request-level guard (`isAuthenticated`, `getSessionUser`) plus
  the short-TTL session cache and the `DISABLE_AUTH` dev bypass
- `api/auth/{login,logout,me}.ts` — HTTP surface
- `docs/DEPLOYMENT.md` §5 — account provisioning and the Cloudflare Access cutover
