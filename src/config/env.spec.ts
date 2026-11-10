import { validateEnv } from './env';

const base = {
  FRONTEND_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://x',
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
    const prod = { ...base, FRONTEND_URL: 'https://shreefoods.us', REVALIDATE_SECRET: 'a-long-enough-revalidate-secret', NODE_ENV: 'production', SESSION_SECRET: 'a-real-production-secret-value' };
    expect(() => validateEnv(prod)).toThrow(/Cloudflare R2 or Cloudinary/);
    const cloud = { ...prod, CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
    expect(() => validateEnv(cloud)).toThrow(/RESEND_API_KEY/);
    expect(validateEnv({ ...cloud, RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shree <a@b.co>' }).NODE_ENV).toBe('production');
  });
  it('requires an https website address and the revalidate secret in production', () => {
    const ok = { ...base, NODE_ENV: 'production', SESSION_SECRET: 'a-real-production-secret-value', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shree <a@b.co>', REVALIDATE_SECRET: 'a-long-enough-revalidate-secret', FRONTEND_URL: 'https://shreefoods.us' };
    expect(validateEnv(ok).NODE_ENV).toBe('production');
    expect(() => validateEnv({ ...ok, FRONTEND_URL: 'http://shreefoods.us' })).toThrow(/https/);
    expect(() => validateEnv({ ...ok, REVALIDATE_SECRET: undefined })).toThrow(/REVALIDATE_SECRET/);
  });
  it('accepts Cloudflare R2 alone as image storage, but only when all five settings are present', () => {
    const r2 = { R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PUBLIC_URL: 'https://pub-x.r2.dev' };
    const prod = { ...base, ...r2, NODE_ENV: 'production', SESSION_SECRET: 'a-real-production-secret-value', RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shree <a@b.co>', REVALIDATE_SECRET: 'a-long-enough-revalidate-secret', FRONTEND_URL: 'https://shreefoods.us' };
    expect(validateEnv(prod).R2_BUCKET).toBe('b');
    expect(() => validateEnv({ ...prod, R2_BUCKET: undefined })).toThrow(/R2_BUCKET/);
  });
  it('rejects the dev secret in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'dev-only-change-me-please' }),
    ).toThrow(/SESSION_SECRET/);
  });
});
