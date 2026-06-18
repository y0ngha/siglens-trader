import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const mockMigrate = vi.fn().mockResolvedValue(undefined);
const mockDb = {};

vi.mock('@neondatabase/serverless', () => ({
    neon: vi.fn(() => vi.fn()),
}));

vi.mock('drizzle-orm/neon-http', () => ({
    drizzle: vi.fn(() => mockDb),
}));

vi.mock('drizzle-orm/neon-http/migrator', () => ({
    migrate: mockMigrate,
}));

describe('migrate', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv, DATABASE_URL: 'postgresql://test:test@localhost/test' };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('throws if DATABASE_URL is missing', async () => {
        delete process.env.DATABASE_URL;

        const { main } = await import('../migrate');
        await expect(main()).rejects.toThrow('DATABASE_URL is required');
    });

    it('calls migrate with correct migrationsFolder', async () => {
        const { main } = await import('../migrate');
        await main();

        expect(mockMigrate).toHaveBeenCalledWith(mockDb, { migrationsFolder: './drizzle' });
    });
});

describe('0010 cron analysis reliability migration', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = resolve(__dirname, '../../../drizzle/0010_cron_analysis_reliability.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    it('adds the source_analyzed_at column', () => {
        expect(sql).toContain('source_analyzed_at');
    });

    it('seeds the analysis_timeframe operational default', () => {
        expect(sql).toContain(`'analysis_timeframe', '"1Hour"'::jsonb`);
    });

    it('converts existing 1Day timeframe to 1Hour', () => {
        expect(sql).toContain(`"value" = '"1Hour"'::jsonb`);
    });

    it('inserts analysis model config rows idempotently', () => {
        expect(sql).toContain(`ON CONFLICT ("analysis_type") DO NOTHING`);
    });

    it('uses Flash Lite for fresh database analysis configs', () => {
        expect(sql.match(/'gemini-2\.5-flash-lite'/g)).toHaveLength(4);
    });

    it('does not overwrite existing analysis model configs', () => {
        expect(sql).toContain(`ON CONFLICT ("analysis_type") DO NOTHING`);
        expect(sql).not.toMatch(/UPDATE\s+"analysis_model_config"/i);
    });
});
