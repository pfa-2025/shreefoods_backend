import { Controller, Get, Header, Logger, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminAuthGuard, Roles } from '../auth/auth.guard';
import { AdminRequest } from '../auth/auth.types';
import { AdminService, DashboardQuery, ExportQuery, OrdersQuery, dashboardQuerySchema, exportQuerySchema, ordersQuerySchema } from './admin.service';
import { buildOrdersWorkbook, wallClock } from './orders-export';

/** Every route here requires a signed-in admin. Write routes added later inherit the same guard. */
@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  dashboard(@Req() req: AdminRequest, @Query(new ZodValidationPipe(dashboardQuerySchema)) q: DashboardQuery) {
    return this.admin.dashboard(req.admin, q);
  }

  @Get('orders')
  orders(@Query(new ZodValidationPipe(ordersQuerySchema)) q: OrdersQuery) {
    return this.admin.orders(q);
  }

  /**
   * Download matching orders as an Excel workbook. Owner-only: it contains customer contact details
   * and revenue, so staff can use the screens but cannot take a bulk copy.
   */
  @Get('orders/export')
  @Roles('OWNER')
  @Header('Cache-Control', 'no-store')
  async exportOrders(@Req() req: AdminRequest, @Query(new ZodValidationPipe(exportQuerySchema)) q: ExportQuery): Promise<StreamableFile> {
    const orders = await this.admin.ordersForExport(q);
    const generatedAt = new Date();
    const file = await buildOrdersWorkbook(orders, { tz: q.tz, generatedAt, filters: { from: q.from, to: q.to, status: q.status, payment: q.payment, q: q.q } });
    this.logger.log(`Order export by ${req.admin.email}: ${orders.length} orders`); // who took a copy of customer data, and how much
    const day = wallClock(generatedAt, q.tz).toISOString().slice(0, 10);
    return new StreamableFile(file, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="shree-foods-orders-${day}.xlsx"`,
    });
  }
}
