import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { primaryFrontendUrl } from '../config/frontend-urls';

/**
 * After a CMS save, ask the web app to drop its cached public content so edits appear at once,
 * with no redeploy. Best effort: the web app also refreshes on its own within minutes, so a
 * failure here only delays visibility and must never fail the admin's save.
 */
@Injectable()
export class RevalidateService {
  private readonly logger = new Logger(RevalidateService.name);
  constructor(private readonly config: ConfigService) {}

  async content(): Promise<void> {
    const secret = this.config.get<string>('REVALIDATE_SECRET');
    if (!secret) return;
    try {
      const res = await fetch(`${primaryFrontendUrl(this.config.getOrThrow<string>('FRONTEND_URL'))}/api/revalidate`, {
        method: 'POST',
        headers: { 'x-revalidate-secret': secret },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) this.logger.warn(`Web app refused revalidation (${res.status})`);
    } catch (e) {
      this.logger.warn(`Could not reach the web app to refresh content: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

@Global()
@Module({ providers: [RevalidateService], exports: [RevalidateService] })
export class RevalidateModule {}
