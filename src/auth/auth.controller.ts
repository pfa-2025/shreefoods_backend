import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminAuthGuard, assertCsrfSafe } from './auth.guard';
import { AuthService } from './auth.service';
import { AdminRequest, AuthedAdmin, SESSION_COOKIE, sessionCookieOptions } from './auth.types';
import { MIN_PASSWORD_LENGTH } from './password';

const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) });
const forgotSchema = z.object({ email: z.string().trim().email().max(254) });
const resetSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200),
});

@Controller('admin/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOptions(maxAgeMs: number) {
    return sessionCookieOptions(this.config.get<string>('NODE_ENV'), maxAgeMs);
  }
  private csrf(req: Request) {
    assertCsrfSafe(req, this.config.getOrThrow<string>('FRONTEND_URL'));
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ admin: AuthedAdmin }> {
    this.csrf(req);
    const { token, admin } = await this.auth.login(body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(this.auth.sessionTtlMs));
    return { admin };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    this.csrf(req);
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions(0));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@Req() req: AdminRequest): { admin: AuthedAdmin } {
    return { admin: req.admin };
  }

  @Post('forgot-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgot(@Body(new ZodValidationPipe(forgotSchema)) body: z.infer<typeof forgotSchema>, @Req() req: Request): Promise<{ ok: true }> {
    this.csrf(req);
    await this.auth.requestPasswordReset(body.email);
    return { ok: true }; // identical response whether or not the email exists
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async reset(@Body(new ZodValidationPipe(resetSchema)) body: z.infer<typeof resetSchema>, @Req() req: Request): Promise<{ ok: true }> {
    this.csrf(req);
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }
}
