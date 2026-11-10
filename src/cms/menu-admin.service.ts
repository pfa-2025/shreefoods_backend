import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../revalidate/revalidate.service';
import { CategoryInput, CategoryPatch, ItemInput, ItemOrderInput, ItemPatch, IdListInput } from './cms.schemas';
import { asLabels } from '../menu/dietary-labels';
import { uniqueSlug } from './slug';

type ItemRow = Prisma.MenuItemGetPayload<{ include: { image: true } }>;

const itemView = (i: ItemRow) => ({
  id: i.id,
  categoryId: i.categoryId,
  name: i.name,
  slug: i.slug,
  description: i.description,
  priceCents: i.priceCents,
  imageId: i.imageId,
  imageUrl: i.image?.url ?? null,
  imageAlt: i.image?.altText ?? '',
  isAvailable: i.isAvailable,
  isArchived: i.isArchived,
  isFeatured: i.isFeatured,
  dietaryLabels: asLabels(i.dietaryLabels),
  sortOrder: i.sortOrder,
});

@Injectable()
export class MenuAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateService,
  ) {}

  /** Everything, archived included, so staff can restore things. */
  async list() {
    const cats = await this.prisma.menuCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { image: true } } },
    });
    return {
      categories: cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug, sortOrder: c.sortOrder, isArchived: c.isArchived, items: c.items.map(itemView) })),
    };
  }

  async createCategory(input: CategoryInput) {
    const slug = await uniqueSlug(input.name, async (s) => !!(await this.prisma.menuCategory.findUnique({ where: { slug: s } })));
    const last = await this.prisma.menuCategory.aggregate({ _max: { sortOrder: true } });
    const c = await this.prisma.menuCategory.create({ data: { name: input.name, slug, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    await this.revalidate.content();
    return { id: c.id, name: c.name, slug: c.slug, sortOrder: c.sortOrder, isArchived: c.isArchived, items: [] };
  }

  async updateCategory(id: string, patch: CategoryPatch) {
    await this.mustExist('menuCategory', id, 'Category not found');
    const c = await this.prisma.menuCategory.update({ where: { id }, data: patch });
    await this.revalidate.content();
    return { id: c.id, name: c.name, slug: c.slug, sortOrder: c.sortOrder, isArchived: c.isArchived };
  }

  async reorderCategories({ ids }: IdListInput) {
    this.assertUnique(ids);
    const found = await this.prisma.menuCategory.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new BadRequestException('Unknown category in the list');
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.menuCategory.update({ where: { id }, data: { sortOrder: i } })));
    await this.revalidate.content();
    return this.list();
  }

  async createItem(input: ItemInput) {
    await this.assertCategory(input.categoryId);
    await this.assertImage(input.imageId);
    const slug = await uniqueSlug(input.name, async (s) => !!(await this.prisma.menuItem.findUnique({ where: { slug: s } })));
    const i = await this.prisma.menuItem.create({
      data: { ...input, slug, sortOrder: await this.nextItemOrder(input.categoryId) },
      include: { image: true },
    });
    await this.revalidate.content();
    return itemView(i);
  }

  async updateItem(id: string, patch: ItemPatch) {
    const current = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Item not found');
    if (patch.categoryId && patch.categoryId !== current.categoryId) await this.assertCategory(patch.categoryId);
    if (patch.imageId !== undefined) await this.assertImage(patch.imageId);
    const moved = patch.categoryId && patch.categoryId !== current.categoryId;
    const i = await this.prisma.menuItem.update({
      where: { id },
      data: { ...patch, ...(moved && { sortOrder: await this.nextItemOrder(patch.categoryId as string) }) },
      include: { image: true },
    });
    await this.revalidate.content();
    return itemView(i);
  }

  async duplicateItem(id: string) {
    const src = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('Item not found');
    const name = `${src.name} (copy)`.slice(0, 80);
    const slug = await uniqueSlug(name, async (s) => !!(await this.prisma.menuItem.findUnique({ where: { slug: s } })));
    const i = await this.prisma.menuItem.create({
      data: {
        categoryId: src.categoryId, name, slug, description: src.description, priceCents: src.priceCents, imageId: src.imageId,
        dietaryLabels: asLabels(src.dietaryLabels), isFeatured: false,
        isAvailable: false, // a copy stays hidden from ordering until someone reviews it
        sortOrder: await this.nextItemOrder(src.categoryId),
      },
      include: { image: true },
    });
    await this.revalidate.content();
    return itemView(i);
  }

  async setAvailability(id: string, isAvailable: boolean) {
    await this.mustExist('menuItem', id, 'Item not found');
    const i = await this.prisma.menuItem.update({ where: { id }, data: { isAvailable }, include: { image: true } });
    await this.revalidate.content();
    return itemView(i);
  }

  async reorderItems({ categoryId, ids }: ItemOrderInput) {
    this.assertUnique(ids);
    const found = await this.prisma.menuItem.count({ where: { id: { in: ids }, categoryId } });
    if (found !== ids.length) throw new BadRequestException('Every item must belong to that category');
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.menuItem.update({ where: { id }, data: { sortOrder: i } })));
    await this.revalidate.content();
    return this.list();
  }

  // ---- helpers ----
  private assertUnique(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Duplicate ids in the list');
  }
  private async mustExist(model: 'menuCategory' | 'menuItem', id: string, msg: string) {
    const row = await (this.prisma[model] as unknown as { findUnique: (a: { where: { id: string } }) => Promise<unknown> }).findUnique({ where: { id } });
    if (!row) throw new NotFoundException(msg);
  }
  private async assertCategory(id: string) {
    const c = await this.prisma.menuCategory.findUnique({ where: { id } });
    if (!c) throw new BadRequestException('Choose a valid category');
    if (c.isArchived) throw new BadRequestException('That category is archived');
  }
  private async assertImage(id: string | null | undefined) {
    if (id && !(await this.prisma.mediaAsset.findUnique({ where: { id } }))) throw new BadRequestException('That image no longer exists');
  }
  private async nextItemOrder(categoryId: string) {
    const last = await this.prisma.menuItem.aggregate({ where: { categoryId }, _max: { sortOrder: true } });
    return (last._max.sortOrder ?? -1) + 1;
  }
}
