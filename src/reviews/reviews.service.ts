import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../revalidate/revalidate.service';
import { AdminReviewsQuery, ModerateReviewInput, SubmitReviewInput, looksLikeContactDetails, publicName } from './reviews.schemas';

/** What the customer sees about their own review. A hidden review reads as "received", so nobody is told they were censored. */
export interface OwnReview {
  rating: number;
  comment: string | null;
  displayName: string;
  visibility: 'public' | 'received';
  reply: string | null;
}

const PAGE_SIZE = 25;
export const REVIEWABLE = ['READY', 'COMPLETED'] as const;

export const toOwnReview = (r: { rating: number; comment: string | null; displayName: string; status: ReviewStatus; reply: string | null }): OwnReview => ({
  rating: r.rating,
  comment: r.comment,
  displayName: r.displayName,
  visibility: r.status === 'PUBLISHED' ? 'public' : 'received',
  reply: r.status === 'PUBLISHED' ? r.reply : null,
});

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateService,
  ) {}

  /** The customer, using their private order link, reviews their own order. Lands as PENDING until the owner approves it. */
  async submit(token: string, input: SubmitReviewInput): Promise<OwnReview> {
    const order = await this.prisma.order.findUnique({ where: { publicToken: token }, include: { review: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (!(REVIEWABLE as readonly string[]).includes(order.fulfillmentStatus)) {
      throw new ConflictException('You can review your order once it is ready');
    }
    if (order.review) throw new ConflictException('You’ve already reviewed this order. Thank you!');
    if (input.displayName && looksLikeContactDetails(input.displayName)) {
      throw new BadRequestException({ message: 'Validation failed', details: [{ path: 'displayName', message: 'Use just your first name. Please don’t include contact details.' }] });
    }
    try {
      const r = await this.prisma.review.create({
        data: { orderId: order.id, rating: input.rating, comment: input.comment ?? null, displayName: input.displayName ?? publicName(order.customerName) },
      });
      return toOwnReview(r);
    } catch (e) {
      // Two simultaneous submissions: the unique constraint lets exactly one through.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('You’ve already reviewed this order. Thank you!');
      throw e;
    }
  }

  /** Public: published reviews only, no personal details. */
  async publicList() {
    const [agg, rows] = await Promise.all([
      this.prisma.review.aggregate({ where: { status: 'PUBLISHED' }, _avg: { rating: true }, _count: true }),
      this.prisma.review.findMany({ where: { status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return {
      summary: { count: agg._count, average: agg._avg.rating === null ? null : Math.round(agg._avg.rating * 10) / 10 },
      reviews: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        displayName: r.displayName,
        createdAt: r.createdAt.toISOString(),
        reply: r.reply,
        repliedAt: r.repliedAt?.toISOString() ?? null,
      })),
    };
  }

  // ---------- owner moderation ----------

  async adminList(q: AdminReviewsQuery) {
    const where: Prisma.ReviewWhereInput = q.status ? { status: q.status } : {};
    const [total, rows, counts] = await Promise.all([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        // pending first so nothing waits unnoticed, then newest
        orderBy: [{ createdAt: 'desc' }],
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { order: { select: { orderNumber: true, customerName: true, customerEmail: true } } },
      }),
      this.prisma.review.groupBy({ by: ['status'], _count: true }),
    ]);
    const c = (s: ReviewStatus) => counts.find((x) => x.status === s)?._count ?? 0;
    return {
      total,
      page: q.page,
      pageSize: PAGE_SIZE,
      counts: { pending: c('PENDING'), published: c('PUBLISHED'), hidden: c('HIDDEN') },
      reviews: rows.map((r) => ({
        id: r.id,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customerName,
        customerEmail: r.order.customerEmail,
        rating: r.rating,
        comment: r.comment,
        displayName: r.displayName,
        status: r.status,
        reply: r.reply,
        repliedAt: r.repliedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async moderate(id: string, input: ModerateReviewInput) {
    const existing = await this.prisma.review.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Review not found');
    const replyChanged = input.reply !== undefined && input.reply !== existing.reply;
    await this.prisma.review.update({
      where: { id },
      data: {
        ...(input.status && { status: input.status }),
        ...(input.reply !== undefined && { reply: input.reply, repliedAt: input.reply && replyChanged ? new Date() : input.reply ? existing.repliedAt : null }),
      },
    });
    await this.revalidate.content();
    return (await this.adminList({ page: 1 })).reviews.find((r) => r.id === id) ?? { id };
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.review.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Review not found');
    await this.revalidate.content();
  }
}
