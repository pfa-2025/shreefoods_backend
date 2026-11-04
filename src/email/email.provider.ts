import { Logger } from '@nestjs/common';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export abstract class EmailProvider {
  /** "resend" sends real mail; "log" only prints (development) and must never be mistaken for delivery. */
  abstract readonly name: 'resend' | 'log';
  /** `idempotencyKey` lets the provider drop a retried request it already accepted. */
  abstract send(msg: OutgoingEmail, idempotencyKey: string): Promise<void>;
}

/**
 * Resend over its REST API (no SDK).
 * NOTE: implemented to Resend's documented API but NOT yet exercised against a live account.
 * Verify with a real key and a verified sending domain before launch.
 */
export class ResendProvider extends EmailProvider {
  readonly name = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo?: string,
  ) {
    super();
  }

  async send(msg: OutgoingEmail, idempotencyKey: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(this.replyTo && { reply_to: this.replyTo }) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Resend's error body explains the problem; never include the API key or message body in errors.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Resend responded ${res.status}: ${detail}`);
    }
  }
}

/** Development stand-in. Prints a summary; nothing leaves this computer. */
export class LogProvider extends EmailProvider {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Email[LOG ONLY - not sent]');

  send(msg: OutgoingEmail): Promise<void> {
    this.logger.log(`subject="${msg.subject}"`); // no address or body: this is only a development trace
    return Promise.resolve();
  }
}
