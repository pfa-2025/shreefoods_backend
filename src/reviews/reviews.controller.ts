import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, Roles } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminReviewsQuery, ModerateReviewInput, adminReviewsQuery, moderateReviewSchema } from './reviews.schemas';
import { ReviewsService } from './reviews.service';

/** Public: published reviews and the average. No personal details. */
@Controller('reviews')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list() {
    return this.reviews.publicList();
  }
}

/** Reviews appear on the public website, so only the owner moderates them. */
@Controller('admin/reviews')
@UseGuards(AdminAuthGuard)
@Roles('OWNER')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(adminReviewsQuery)) q: AdminReviewsQuery) {
    return this.reviews.adminList(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(moderateReviewSchema)) body: ModerateReviewInput) {
    return this.reviews.moderate(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.reviews.remove(id);
  }
}
