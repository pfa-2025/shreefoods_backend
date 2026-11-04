import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PasswordResetNotifier } from '../auth/password-reset.notifier';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { renderPasswordReset } from './email.templates';

/** Emails the reset link. In development without a provider, also prints the link so you can use it. */
@Injectable()
export class EmailPasswordResetNotifier extends PasswordResetNotifier {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async send(to: string, token: string): Promise<void> {
    const url = `${this.config.getOrThrow<string>('FRONTEND_URL')}/admin/reset-password?token=${token}`;
    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    if (this.email.providerName === 'log' && this.config.get('NODE_ENV') !== 'production') {
      this.logger.log(`DEV ONLY reset link for ${to}: ${url}`);
    }
    await this.email.enqueue({
      template: 'password_reset',
      to,
      dedupeKey: `reset:${token.slice(0, 16)}`,
      message: { to, ...renderPasswordReset(settings?.restaurantName ?? 'Shree Foods', url) },
      sensitive: true, // the link is a credential: not stored, not retried (the user can simply ask again)
    });
  }
}
