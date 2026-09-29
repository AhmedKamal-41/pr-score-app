import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { EXAMPLE_ADMIN_PASSWORD_HASH } from '../config/env.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery', { logN: 12 });
    expect(hash.startsWith('scrypt$12$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterx', hash)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password!!', { logN: 12 }), hashPassword('same password!!', { logN: 12 })]);
    expect(a).not.toBe(b);
  });

  it('rejects short passwords and malformed hashes', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
    expect(await verifyPassword('anything', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$99$8$1$aaaa$bbbb')).toBe(false);
  });

  it('matches the documented local example password', async () => {
    expect(await verifyPassword('local-dev-password-change-me', EXAMPLE_ADMIN_PASSWORD_HASH)).toBe(true);
  });
});
