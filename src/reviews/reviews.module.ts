import { Module } from '@nestjs/common';
import { AdminReviewsController, PublicReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({ controllers: [PublicReviewsController, AdminReviewsController], providers: [ReviewsService], exports: [ReviewsService] })
export class ReviewsModule {}
