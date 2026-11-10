import { z } from 'zod';
import { frontendUrls } from './frontend-urls';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // One website address, or several separated by commas (the first is the main one); see frontend-urls.ts
  FRONTEND_URL: z.string().refine((v) => {
    const urls = frontendUrls(v);
    return urls.length > 0 && urls.every((u) => z.string().url().safeParse(u).success);
  }, 'must be one or more valid URLs, separated by commas'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  // Reverse-proxy hops in front of the API (Vercel rewrite + host load balancer); controls req.ip for rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  // Media storage: Cloudinary when all three are set, otherwise local disk (development only).
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // Media storage: Cloudflare R2 when all five are set (takes priority over Cloudinary).
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().url().optional(),
  UPLOAD_DIR: z.string().default('./uploads'),
  // Shared secret for telling the web app to refresh its cached content after a CMS save.
  REVALIDATE_SECRET: z.string().min(16).optional(),
  // Transactional email via Resend. Without a key, emails are logged (development) and never sent.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(), // e.g. "Shree Foods <orders@yourdomain.com>"
  EMAIL_REPLY_TO: z.string().email().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
});

export type Env = z.infer<typeof schema>;

/** Used by ConfigModule so the app refuses to boot with a bad environment. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET must be changed for production');
  }
  const d = parsed.data;
  const cloudinary = [d.CLOUDINARY_CLOUD_NAME, d.CLOUDINARY_API_KEY, d.CLOUDINARY_API_SECRET].filter(Boolean).length;
  if (cloudinary !== 0 && cloudinary !== 3) {
    throw new Error('Set all of CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, or none');
  }
  const r2 = [d.R2_ENDPOINT, d.R2_ACCESS_KEY_ID, d.R2_SECRET_ACCESS_KEY, d.R2_BUCKET, d.R2_PUBLIC_URL].filter(Boolean).length;
  if (r2 !== 0 && r2 !== 5) {
    throw new Error('Set all of R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL, or none');
  }
  if (d.NODE_ENV === 'production' && cloudinary === 0 && r2 === 0) {
    throw new Error('Production needs Cloudflare R2 or Cloudinary: local disk uploads are lost whenever the host restarts');
  }
  if (d.NODE_ENV === 'production' && !frontendUrls(d.FRONTEND_URL).every((u) => u.startsWith('https://'))) {
    throw new Error('Every FRONTEND_URL address must be https:// in production (cookies and CORS depend on it)');
  }
  if (d.NODE_ENV === 'production' && !d.REVALIDATE_SECRET) {
    throw new Error('Production needs REVALIDATE_SECRET so website edits show up immediately');
  }
  if (d.NODE_ENV === 'production' && (!d.RESEND_API_KEY || !d.EMAIL_FROM)) {
    throw new Error('Production needs RESEND_API_KEY and EMAIL_FROM so customers receive order emails');
  }
  return d;
}
