import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { asLabels } from './dietary-labels';

export interface PublicMenuItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string | null;
  imageAlt: string;
  isAvailable: boolean;
  isFeatured: boolean;
  dietaryLabels: string[];
}

export interface PublicMenuCategory {
  id: string;
  slug: string;
  name: string;
  items: PublicMenuItem[];
}

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublicMenu(): Promise<PublicMenuCategory[]> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { isArchived: false },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' }, include: { image: true } },
      },
    });
    return categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      items: c.items.map((i) => ({
        id: i.id,
        slug: i.slug,
        name: i.name,
        description: i.description,
        priceCents: i.priceCents,
        imageUrl: i.image?.url ?? null,
        imageAlt: i.image?.altText ?? i.name,
        isAvailable: i.isAvailable,
        isFeatured: i.isFeatured,
        dietaryLabels: asLabels(i.dietaryLabels),
      })),
    }));
  }
}
