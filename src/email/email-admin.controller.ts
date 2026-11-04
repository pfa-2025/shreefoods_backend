import { Controller, Get, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';

/** Delivery history for an order, so staff can see whether the customer was actually told. */
@Controller('admin')
@UseGuards(AdminAuthGuard)
export class EmailAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  @Get('orders/:id/emails')
  async forOrder(@Param('id') id: string) {
    const rows = await this.prisma.emailLog.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } });
    return {
      provider: this.email.providerName,
      emails: rows.map((r) => ({
        id: r.id, template: r.template, subject: r.subject, status: r.status, attempts: r.attempts, error: r.error,
        provider: r.provider, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null,
        nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
      })),
    };
  }

  @Post('emails/:id/retry')
  @HttpCode(200)
  async retry(@Param('id') id: string) {
    if (!(await this.prisma.emailLog.findUnique({ where: { id } }))) throw new NotFoundException('Email not found');
    return { retried: await this.email.retry(id) };
  }
}
