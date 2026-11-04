import { DUMMY_HASH, hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });
  it('salts: the same password hashes differently', async () => {
    expect(await hashPassword('same-password-123')).not.toBe(await hashPassword('same-password-123'));
  });
  it('never stores the plain password', async () => {
    expect(await hashPassword('plain-text-secret')).not.toContain('plain-text-secret');
  });
  it('rejects malformed stored hashes and the dummy hash', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('anything-at-all', DUMMY_HASH)).toBe(false);
  });
});
