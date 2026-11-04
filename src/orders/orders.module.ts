import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { OrderActionsController } from './order-actions.controller';
import { OrderActionsService } from './order-actions.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({ imports: [CartModule, ReviewsModule], controllers: [OrdersController, OrderActionsController], providers: [OrdersService, OrderActionsService] })
export class OrdersModule {}
