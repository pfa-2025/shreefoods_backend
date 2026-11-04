import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CartService, Quote, QuoteInput, quoteSchema } from './cart.service';

@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  /** Stateless price quote. Does not create anything. */
  @Post('quote')
  @HttpCode(200)
  quote(@Body(new ZodValidationPipe(quoteSchema)) body: QuoteInput): Promise<Quote> {
    return this.cart.quote(body);
  }
}
