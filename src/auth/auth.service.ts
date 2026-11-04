import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedAdmin } from './auth.types';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { PasswordResetNotifier } from './password-reset.notifier';

const RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifier: PasswordResetNotifier,
  ) {}

  get sessionTtlMs(): number {
    return this.config.getOrThrow<number>('SESSION_TTL_HOURS') * 3_600_000;
  }

  /** Only a keyed hash of the token is stored, so a database leak doesn't leak live sessions. */
  private hashToken(token: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('SESSION_SECRET')).update(token).digest('hex');
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    const ok = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH);
    if (!admin || !admin.isActive || !ok) {
      this.logger.warn(`Failed admin login for ${email} from ${meta.ip ?? 'unknown'}`);
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    await this.prisma.adminSession.create({
      data: { adminId: admin.id, tokenHash: this.hashToken(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
    });
    // Opportunistic cleanup keeps the table small without a cron job.
    await this.prisma.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return { token, expiresAt, admin: this.toAuthed(admin) };
  }

  async authenticate(token: string): Promise<{ admin: AuthedAdmin; sessionId: string } | null> {
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { admin: true },
    });
    if (!session || session.expiresAt <= new Date() || !session.admin.isActive) return null;
    return { admin: this.toAuthed(session.admin), sessionId: session.id };
  }

  async logout(token: string): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { tokenHash: this.hashToken(token) } });
  }

  /** Always resolves the same way so the response can't be used to discover admin emails. */
  async requestPasswordReset(email: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin || !admin.isActive) return;
    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: { adminId: admin.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    await this.notifier.send(admin.email, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new UnauthorizedException('This reset link is invalid or has expired');
    }
    const passwordHash = await hashPassword(newPassword);
    // Single-use token + new password + sign out everywhere, atomically.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (count !== 1) return false;
      await tx.adminUser.update({ where: { id: record.adminId }, data: { passwordHash } });
      await tx.adminSession.deleteMany({ where: { adminId: record.adminId } });
      return true;
    });
    if (!claimed) throw new UnauthorizedException('This reset link is invalid or has expired');
  }

  private toAuthed(a: { id: string; email: string; name: string; role: AuthedAdmin['role'] }): AuthedAdmin {
    return { id: a.id, email: a.email, name: a.name, role: a.role };
  }
}
