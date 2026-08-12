import { compare, hash } from 'bcryptjs';

/**
 * bcrypt cost 12 — the same value siglens uses. Keeping the algorithm and cost
 * identical means operator hashes stay verifiable if the two account systems
 * are ever merged.
 */
export const BCRYPT_SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
    return hash(password, BCRYPT_SALT_ROUNDS);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
}
