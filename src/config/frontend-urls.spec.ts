import type { Request } from 'express';
import { assertCsrfSafe } from '../auth/auth.guard';
import { allowedOrigins, frontendUrls, primaryFrontendUrl } from './frontend-urls';
import { validateEnv } from './env';

const two = 'https://shreefoods.us, https://shreefoods-web.vercel.app/';
const req = (origin?: string, method = 'POST') => ({ method, headers: { origin, 'x-requested-with': 'shree-admin' } }) as unknown as Request;

describe('FRONTEND_URL list', () => {
  it('splits, trims and drops trailing slashes', () => {
    expect(frontendUrls(two)).toEqual(['https://shreefoods.us', 'https://shreefoods-web.vercel.app']);
    expect(frontendUrls('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });
  it('uses the first address as the main one', () => {
    expect(primaryFrontendUrl(two)).toBe('https://shreefoods.us');
  });
  it('turns each address into a browser origin', () => {
    expect(allowedOrigins('https://a.example/path/,https://b.example:8443')).toEqual(['https://a.example', 'https://b.example:8443']);
  });
  it('lets sign-in come from any listed site, and blocks every other', () => {
    expect(() => assertCsrfSafe(req('https://shreefoods.us'), two)).not.toThrow();
    expect(() => assertCsrfSafe(req('https://shreefoods-web.vercel.app'), two)).not.toThrow();
    expect(() => assertCsrfSafe(req('https://evil.example'), two)).toThrow(/Cross-origin/);
    expect(() => assertCsrfSafe(req('https://shreefoods.us.evil.example'), two)).toThrow(/Cross-origin/);
  });
  it('accepts a list in the environment, but in production every address must be https', () => {
    const prod = { DATABASE_URL: 'mysql://x', SESSION_SECRET: 'a-real-production-secret-value', NODE_ENV: 'production', REVALIDATE_SECRET: 'a-long-enough-revalidate-secret', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a <a@b.co>', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
    expect(validateEnv({ ...prod, FRONTEND_URL: two }).FRONTEND_URL).toBe(two);
    expect(() => validateEnv({ ...prod, FRONTEND_URL: 'https://shreefoods.us,http://shreefoods-web.vercel.app' })).toThrow(/https/);
    expect(() => validateEnv({ ...prod, FRONTEND_URL: 'https://shreefoods.us,not a url' })).toThrow(/FRONTEND_URL/);
  });
});
