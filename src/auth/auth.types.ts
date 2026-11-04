import { AdminRole } from '@prisma/client';
import type { Request } from 'express';

export interface AuthedAdmin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}
export type AdminRequest = Request & { admin: AuthedAdmin; sessionId: string };

export const SESSION_COOKIE = 'sf_admin';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'shree-admin';

/** Session cookie settings. httpOnly keeps it from scripts; Secure is required whenever not in development. */
export function sessionCookieOptions(nodeEnv: string | undefined, maxAgeMs: number) {
  return { httpOnly: true, secure: nodeEnv === 'production', sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}
