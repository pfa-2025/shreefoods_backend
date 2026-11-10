import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { allowedOrigins } from '../config/frontend-urls';
import { AdminRequest, CSRF_HEADER, CSRF_VALUE, SESSION_COOKIE } from './auth.types';

export const ROLES_KEY = 'roles';
/** Restrict a route to specific roles. Without it, any signed-in admin is allowed. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * CSRF defence for cookie auth: SameSite=Lax cookie, plus every state-changing request
 * must carry a custom header (which forces a CORS preflight) and a matching Origin.
 */
export function assertCsrfSafe(req: Request, frontendUrl: string): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && !allowedOrigins(frontendUrl).includes(origin)) throw new ForbiddenException('Cross-origin request blocked');
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) throw new ForbiddenException('Missing request header');
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Sign in required');

    const session = await this.auth.authenticate(token);
    if (!session) throw new UnauthorizedException('Your session has expired. Please sign in again.');

    assertCsrfSafe(req, this.config.getOrThrow<string>('FRONTEND_URL'));

    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(session.admin.role)) throw new ForbiddenException('You don’t have permission to do that');

    Object.assign(req, { admin: session.admin, sessionId: session.sessionId } satisfies Pick<AdminRequest, 'admin' | 'sessionId'>);
    return true;
  }
}
