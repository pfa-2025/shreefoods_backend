import { sessionCookieOptions } from './auth.types';

describe('sessionCookieOptions', () => {
  it('is always httpOnly, SameSite=Lax and site-wide', () => {
    for (const env of ['development', 'production', undefined]) {
      expect(sessionCookieOptions(env, 1000)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 1000 });
    }
  });
  it('is Secure (HTTPS-only) in production', () => {
    expect(sessionCookieOptions('production', 1).secure).toBe(true);
    expect(sessionCookieOptions('development', 1).secure).toBe(false); // local http://localhost
  });
});
