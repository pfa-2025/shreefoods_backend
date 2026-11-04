import { validateEnv } from './env';

const base = {
  FRONTEND_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://x',
  SESSION_SECRET: 'a-sufficiently-long-secret',
};

describe('validateEnv', () => {
  it('accepts a valid environment and applies defaults', () => {
    expect(validateEnv(base)).toMatchObject({ PORT: 4000, NODE_ENV: 'development' });
  });
  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
  it('requires Cloudinary and email settings in production', () => {
    const prod = { ...base, NODE_ENV: 'production', SESSION_SECRET: 'a-real-production-secret-value' };
    expect(() => validateEnv(prod)).toThrow(/Cloudinary/);
    const cloud = { ...prod, CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
    expect(() => validateEnv(cloud)).toThrow(/RESEND_API_KEY/);
    expect(validateEnv({ ...cloud, RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shree <a@b.co>' }).NODE_ENV).toBe('production');
  });
  it('rejects the dev secret in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'dev-only-change-me-please' }),
    ).toThrow(/SESSION_SECRET/);
  });
});
