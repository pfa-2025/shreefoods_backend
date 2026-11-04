import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PasswordResetNotifier } from '../auth/password-reset.notifier';
import { EmailAdminController } from './email-admin.controller';
import { EmailTriggers } from './email-triggers.service';
import { EmailProvider, LogProvider, ResendProvider } from './email.provider';
import { EmailService } from './email.service';
import { EmailPasswordResetNotifier } from './password-reset-email.notifier';

@Global()
@Module({
  controllers: [EmailAdminController],
  providers: [
    {
      provide: EmailProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider => {
        const key = config.get<string>('RESEND_API_KEY');
        const from = config.get<string>('EMAIL_FROM');
        const log = new Logger('Email');
        if (key && from) {
          log.log('Email provider: Resend');
          return new ResendProvider(key, from, config.get<string>('EMAIL_REPLY_TO'));
        }
        log.warn('Email provider: LOG ONLY (development). No email will be sent until RESEND_API_KEY and EMAIL_FROM are set.');
        return new LogProvider();
      },
    },
    EmailService,
    EmailTriggers,
    EmailPasswordResetNotifier,
    { provide: PasswordResetNotifier, useExisting: EmailPasswordResetNotifier },
  ],
  exports: [EmailService, EmailProvider, PasswordResetNotifier],
})
export class EmailModule {}
