import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SubmitReviewInput, submitReviewSchema } from '../reviews/reviews.schemas';
import { OwnReview, ReviewsService } from '../reviews/reviews.service';
import { CreateOrderInput, ReportPaymentInput, createOrderSchema, reportPaymentSchema } from './orders.schemas';
import { OrdersService, PublicOrder } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly reviews: ReviewsService,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
  ): Promise<{ token: string; orderNumber: number }> {
    return this.orders.create(body);
  }

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  get(@Param('token') token: string): Promise<PublicOrder> {
    return this.orders.getByToken(token);
  }

  @Post(':token/report-payment')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reportPayment(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(reportPaymentSchema)) body: ReportPaymentInput,
  ): Promise<PublicOrder> {
    return this.orders.reportPayment(token, body);
  }

  /** The customer reviews their own order (found by their private link). Starts as pending until approved. */
  @Post(':token/review')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  review(@Param('token') token: string, @Body(new ZodValidationPipe(submitReviewSchema)) body: SubmitReviewInput): Promise<OwnReview> {
    return this.reviews.submit(token, body);
  }
}
