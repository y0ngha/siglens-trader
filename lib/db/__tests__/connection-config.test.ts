import { describe, it, expect } from 'vitest';
import { buildPoolConfig, isLocalDatabaseUrl } from '../connection-config';

describe('isLocalDatabaseUrl', () => {
    it.each([
        'postgres://u:p@localhost/db?host=/var/run/postgresql',
        'postgres://u:p@localhost/db?host=localhost&hostaddr=127.0.0.1',
        'postgres://%2Fvar%2Frun%2Fpostgresql/db',
        'postgres://u:p@localhost:5434/db',
        'postgres://u:p@127.0.0.1/db',
        'postgres://u:p@[::1]:5432/db',
        'postgres://u:p@LOCALHOST/db',
        'postgres:///db?host=/var/run/postgresql',
    ])('treats %s as local', (url) => {
        expect(isLocalDatabaseUrl(url)).toBe(true);
    });

    it.each([
        'postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db',
        'postgres://u:p@mydb.abc123.ap-northeast-2.rds.amazonaws.com:5432/db',
        'postgres://u:p@10.0.3.17/db',
        'postgres://u:p@localhost.evil.com/db',
        'not a url',
        // pg-connection-string은 host/hostaddr 쿼리 값을 URL 호스트보다 우선해 접속한다.
        'postgres://u:p@localhost/db?host=x.rds.amazonaws.com',
        'postgres://u:p@127.0.0.1/db?hostaddr=10.0.3.17',
        'postgres://u:p@localhost/db?host=localhost,x.rds.amazonaws.com',
        'postgres://u:p@localhost/db?HOST=x.rds.amazonaws.com',
        'postgres:///db?host=x.rds.amazonaws.com',
    ])('treats %s as remote', (url) => {
        expect(isLocalDatabaseUrl(url)).toBe(false);
    });
});

const HARDENING = {
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
};

describe('buildPoolConfig', () => {
    it('keeps a local URL as-is, with no ssl override (docker Postgres has no TLS)', () => {
        const url = 'postgres://siglens:siglens@localhost:5434/trader_test';
        expect(buildPoolConfig(url)).toEqual({ connectionString: url, ...HARDENING });
    });

    it('keeps the SSM-tunnel URL untouched (sslmode=no-verify is how the tunnel reaches RDS)', () => {
        const url = 'postgres://trader_owner:pw@localhost:6543/trader?sslmode=no-verify';
        expect(buildPoolConfig(url)).toEqual({ connectionString: url, ...HARDENING });
    });

    it('treats a localhost URL whose ?host= points at RDS as remote (TLS enforced)', () => {
        expect(buildPoolConfig('postgres://u:p@localhost/db?host=x.rds.amazonaws.com')).toEqual({
            connectionString: 'postgres://u:p@localhost/db?host=x.rds.amazonaws.com',
            ssl: { rejectUnauthorized: true },
            ...HARDENING,
        });
    });

    it('treats a ?host= unix-socket path as local', () => {
        const url = 'postgres:///db?host=/var/run/postgresql';
        expect(buildPoolConfig(url)).toEqual({ connectionString: url, ...HARDENING });
    });

    it('sets connect/acquire timeout (10s) and TCP keepAlive (30s first probe) for local and remote hosts alike', () => {
        for (const url of ['postgres://u:p@localhost/db', 'postgres://u:p@h.example.com/db']) {
            const cfg = buildPoolConfig(url);
            expect(cfg.connectionTimeoutMillis).toBe(10_000);
            expect(cfg.keepAlive).toBe(true);
            expect(cfg.keepAliveInitialDelayMillis).toBe(30_000);
        }
    });

    it('keeps a local URL untouched even when it carries sslmode', () => {
        const url = 'postgres://u:p@127.0.0.1/db?sslmode=disable';
        expect(buildPoolConfig(url)).toEqual({ connectionString: url, ...HARDENING });
    });

    it('forces verified TLS for a remote URL that has no sslmode (pg would otherwise connect in plaintext)', () => {
        expect(buildPoolConfig('postgres://u:p@mydb.rds.amazonaws.com/db')).toEqual({
            connectionString: 'postgres://u:p@mydb.rds.amazonaws.com/db',
            ssl: { rejectUnauthorized: true },
            ...HARDENING,
        });
    });

    it.each(['require', 'prefer', 'verify-ca', 'verify-full'])(
        'drops sslmode=%s and sets explicit verified TLS (no pg deprecation warning, no semantics drift)',
        (mode) => {
            expect(buildPoolConfig(`postgres://u:p@host.neon.tech/db?sslmode=${mode}`)).toEqual({
                connectionString: 'postgres://u:p@host.neon.tech/db',
                ssl: { rejectUnauthorized: true },
                ...HARDENING,
            });
        },
    );

    it('keeps other query params (and channel_binding) in their original order', () => {
        const cfg = buildPoolConfig(
            'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&application_name=trader',
        );
        expect(cfg.connectionString).toBe(
            'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?channel_binding=require&application_name=trader',
        );
        expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('drops the ssl/uselibpqcompat/sslnegotiation keys that would override the explicit config', () => {
        const cfg = buildPoolConfig(
            'postgres://u:p@h.example.com/db?ssl=true&uselibpqcompat=true&sslnegotiation=direct&sslmode=require',
        );
        expect(cfg.connectionString).toBe('postgres://u:p@h.example.com/db');
    });

    it('does not re-encode the password (string-level query filtering only)', () => {
        const url = 'postgres://u:p%40ss%2Fw%3Ard@h.example.com/db?sslmode=require';
        expect(buildPoolConfig(url).connectionString).toBe(
            'postgres://u:p%40ss%2Fw%3Ard@h.example.com/db',
        );
    });

    it.each(['disable', 'no-verify'])(
        'rejects sslmode=%s on a remote host instead of silently ignoring it',
        (mode) => {
            expect(() =>
                buildPoolConfig(`postgres://u:p@h.example.com/db?sslmode=${mode}`),
            ).toThrow(`sslmode=${mode} is not allowed`);
        },
    );

    it('does not leak the URL (credentials) in the rejection message', () => {
        let message = '';
        try {
            buildPoolConfig('postgres://u:secretpw@h.example.com/db?sslmode=disable');
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('sslmode=disable');
        expect(message).not.toContain('secretpw');
    });
});
