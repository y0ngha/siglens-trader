import { describe, it, expect } from 'vitest';
import { BCRYPT_SALT_ROUNDS, hashPassword, verifyPassword } from '../password';

describe('password hashing', () => {
    it('produces a cost-12 bcrypt hash that verifies against the original', async () => {
        const hash = await hashPassword('correct horse battery staple');

        expect(hash).toMatch(/^\$2[aby]\$12\$/);
        await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
        await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
    });

    it('stays on cost 12 — siglens hashes must remain verifiable after a merge', () => {
        expect(BCRYPT_SALT_ROUNDS).toBe(12);
    });
});
