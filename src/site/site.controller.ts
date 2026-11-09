import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface OpeningHours {
  day: string;
  hours: string; // e.g. "11:00 AM – 9:00 PM" or "Closed"
}
export interface SocialLink {
  label: string;
  url: string;
}
export interface PublicSiteInfo {
  restaurantName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  openingHours: OpeningHours[];
  socialLinks: SocialLink[];
  ordersOpen: boolean;
  cartEnabled: boolean;
  fulfillment: { pickup: boolean; dineIn: boolean; delivery: boolean };
}

/** Public, non-sensitive restaurant info. Payment QR and tax are exposed in later modules. */
@Controller('site')
export class SiteController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async info(): Promise<PublicSiteInfo> {
    const s = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    return {
      restaurantName: s?.restaurantName ?? 'Shree Foods',
      phone: s?.phone ?? null,
      email: s?.email ?? null,
      address: s?.address ?? null,
      openingHours: (s?.openingHours as unknown as OpeningHours[] | undefined) ?? [],
      socialLinks: (s?.socialLinks as unknown as SocialLink[] | undefined) ?? [],
      ordersOpen: s?.ordersOpen ?? true,
      cartEnabled: s?.cartEnabled ?? true,
      fulfillment: {
        pickup: s?.pickupEnabled ?? true,
        dineIn: s?.dineInEnabled ?? false,
        delivery: s?.deliveryEnabled ?? false,
      },
    };
  }
}
