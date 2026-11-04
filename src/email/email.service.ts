import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailProvider, OutgoingEmail } from './email.provider';

/** Wait before attempt N+1 after attempt N failed. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;
const LEASE_MS = 120_000; // while one attempt is in flight, nobody else may pick the row up
const SWEEP_MS = 30_000;

/** "asha.patel@example.com" -> "a***@example.com" for log lines (logs are not where customer addresses should live). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

export interface EnqueueInput {
  template: string;
  to: string;
  orderId?: string;
  /** Unique per logical email, e.g. "<eventId>:order_accepted". A second enqueue with the same key is ignored. */
  dedupeKey: string;
  message: OutgoingEmail;
  /** Contains a secret (password reset link): never stored, never retried. */
  sensitive?: boolean;
}

/**
 * Durable email queue. Every email is a row first, then sent in the background, so a slow or
 * failing provider never blocks (or fails) an order. Each attempt, success or failure, is recorded.
 */
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: EmailProvider,
  ) {}

  get providerName(): 'resend' | 'log' {
    return this.provider.name;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return; // tests drive sweep() themselves
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
    void this.sweep(); // pick up anything left over from before a restart
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Returns the log id, or null if this exact email was already queued (duplicate event). */
  async enqueue(input: EnqueueInput): Promise<string | null> {
    let id: string;
    try {
      const row = await this.prisma.emailLog.create({
        data: {
          orderId: input.orderId,
          template: input.template,
          toEmail: input.to,
          subject: input.message.subject,
          provider: this.provider.name,
          dedupeKey: input.dedupeKey,
          payload: input.sensitive ? Prisma.DbNull : (input.message as unknown as Prisma.InputJsonObject),
        },
      });
      id = row.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
    if (input.sensitive) await this.attempt(id, input.message, input.dedupeKey, true);
    else void this.process(id); // background: the caller does not wait for the provider
    return id;
  }

  /** Claim a due row and try to send it. Safe to call concurrently: only one caller wins the claim. */
  async process(id: string): Promise<void> {
    const now = new Date();
    const { count } = await this.prisma.emailLog.updateMany({
      where: { id, status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (count !== 1) return;
    const row = await this.prisma.emailLog.findUniqueOrThrow({ where: { id } });
    const message = row.payload as unknown as OutgoingEmail | null;
    if (!message) {
      await this.prisma.emailLog.update({ where: { id }, data: { status: 'FAILED', error: 'No stored message to send', nextAttemptAt: null } });
      return;
    }
    await this.attempt(id, message, row.dedupeKey ?? row.id, false);
  }

  private async attempt(id: string, message: OutgoingEmail, idempotencyKey: string, once: boolean): Promise<void> {
    try {
      await this.provider.send(message, idempotencyKey);
      await this.prisma.emailLog.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), error: null, nextAttemptAt: null, ...(once && { attempts: 1 }) },
      });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const row = await this.prisma.emailLog.findUniqueOrThrow({ where: { id } });
      const attempts = once ? 1 : row.attempts;
      const giveUp = once || attempts >= MAX_ATTEMPTS;
      this.logger.warn(`Email ${row.template} to ${maskEmail(row.toEmail)} failed (attempt ${attempts}${giveUp ? ', giving up' : ''}): ${error}`);
      await this.prisma.emailLog.update({
        where: { id },
        data: giveUp
          ? { status: 'FAILED', attempts, error, nextAttemptAt: null }
          : { status: 'QUEUED', attempts, error, nextAttemptAt: new Date(Date.now() + BACKOFF_MS[attempts - 1]) },
      });
    }
  }

  /** Retry everything that is due. Runs on a timer, so retries survive a restart. */
  async sweep(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.emailLog.findMany({
      where: { status: 'QUEUED', OR: [{ nextAttemptAt: { lte: now } }, { nextAttemptAt: null, createdAt: { lt: new Date(now.getTime() - 15_000) } }] },
      orderBy: { createdAt: 'asc' },
      take: 25,
      select: { id: true },
    });
    for (const { id } of due) await this.process(id).catch((e: unknown) => this.logger.error(`sweep ${id}: ${String(e)}`));
    return due.length;
  }

  /** Staff retry of a failed email (only possible while its message was kept). */
  async retry(id: string): Promise<boolean> {
    const { count } = await this.prisma.emailLog.updateMany({
      where: { id, status: 'FAILED', payload: { not: Prisma.DbNull } },
      data: { status: 'QUEUED', attempts: 0, nextAttemptAt: null, error: null },
    });
    if (count !== 1) return false;
    await this.process(id);
    return true;
  }
}
