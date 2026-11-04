import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { EmailModule } from './email/email.module';
import { CmsModule } from './cms/cms.module';
import { CartModule } from './cart/cart.module';
import { LiveModule } from './live/live.module';
import { MediaModule } from './media/media.module';
import { MenuModule } from './menu/menu.module';
import { ReviewsModule } from './reviews/reviews.module';
import { OrdersModule } from './orders/orders.module';
import { SiteModule } from './site/site.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { RevalidateModule } from './revalidate/revalidate.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      skipIf: () => process.env.NODE_ENV === 'test', // e2e tests create many orders quickly
    }),
    PrismaModule,
    HealthModule,
    MenuModule,
    CartModule,
    AuthModule,
    AdminModule,
    LiveModule,
    RevalidateModule,
    MediaModule,
    CmsModule,
    EmailModule,
    OrdersModule,
    ReviewsModule,
    SiteModule,
    AnnouncementsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
