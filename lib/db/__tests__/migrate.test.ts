import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
