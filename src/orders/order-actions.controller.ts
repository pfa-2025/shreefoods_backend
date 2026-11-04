import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard';
import { AdminRequest } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminOrder } from './admin-order';
import {
  CancelInput,
  OrderActionsService,
  RejectPaymentInput,
  StatusInput,
  cancelSchema,
  rejectPaymentSchema,
  statusSchema,
} from './order-actions.service';

/** Staff-only writes. The guard also enforces the CSRF header + origin on every POST. */
@Controller('admin/orders/:id')
@UseGuards(AdminAuthGuard)
export class OrderActionsController {
  constructor(private readonly actions: OrderActionsService) {}

  @Post('verify-payment')
  @HttpCode(200)
  verify(@Param('id') id: string, @Req() req: AdminRequest): Promise<AdminOrder> {
    return this.actions.verifyPayment(id, req.admin);
  }

  @Post('reject-payment')
  @HttpCode(200)
  reject(@Param('id') id: string, @Req() req: AdminRequest, @Body(new ZodValidationPipe(rejectPaymentSchema)) body: RejectPaymentInput): Promise<AdminOrder> {
    return this.actions.rejectPayment(id, req.admin, body);
  }

  @Post('status')
  @HttpCode(200)
  status(@Param('id') id: string, @Req() req: AdminRequest, @Body(new ZodValidationPipe(statusSchema)) body: StatusInput): Promise<AdminOrder> {
    return this.actions.setStatus(id, req.admin, body);
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() req: AdminRequest, @Body(new ZodValidationPipe(cancelSchema)) body: CancelInput): Promise<AdminOrder> {
    return this.actions.cancel(id, req.admin, body);
  }

  @Post('acknowledge')
  @HttpCode(200)
  acknowledge(@Param('id') id: string, @Req() req: AdminRequest): Promise<AdminOrder> {
    return this.actions.acknowledge(id, req.admin);
  }
}
