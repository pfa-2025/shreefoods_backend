import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../revalidate/revalidate.service';
import { AnnouncementInput, AnnouncementPatch, IdListInput, PAGE_KEYS, PageKey, SeoInput, SettingsInput, pageContent, seoSchema } from './cms.schemas';

type AnnRow = Prisma.AnnouncementGetPayload<{ include: { image: true } }>;
const annView = (a: AnnRow) => ({
  id: a.id, title: a.title, body: a.body, imageId: a.imageId, imageUrl: a.image?.url ?? null, imageAlt: a.image?.altText ?? '',
  linkUrl: a.linkUrl, status: a.status, publishAt: a.publishAt?.toISOString() ?? null, sortOrder: a.sortOrder,
});

@Injectable()
export class ContentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateService,
  ) {}

  // ---------- announcements ("What's New") ----------
  async listAnnouncements() {
    const rows = await this.prisma.announcement.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], include: { image: true } });
    return { announcements: rows.map(annView) };
  }

  async createAnnouncement(input: AnnouncementInput) {
    await this.assertImage(input.imageId);
    const last = await this.prisma.announcement.aggregate({ _max: { sortOrder: true } });
    const a = await this.prisma.announcement.create({
      data: { ...input, publishAt: input.publishAt ? new Date(input.publishAt) : null, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      include: { image: true },
    });
    await this.revalidate.content();
    return annView(a);
  }

  async updateAnnouncement(id: string, patch: AnnouncementPatch) {
    if (!(await this.prisma.announcement.findUnique({ where: { id } }))) throw new NotFoundException('Announcement not found');
    if (patch.imageId !== undefined) await this.assertImage(patch.imageId);
    const a = await this.prisma.announcement.update({
      where: { id },
      data: { ...patch, ...(patch.publishAt !== undefined && { publishAt: patch.publishAt ? new Date(patch.publishAt) : null }) },
      include: { image: true },
    });
    await this.revalidate.content();
    return annView(a);
  }

  async reorderAnnouncements({ ids }: IdListInput) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Duplicate ids in the list');
    if ((await this.prisma.announcement.count({ where: { id: { in: ids } } })) !== ids.length) throw new BadRequestException('Unknown announcement in the list');
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.announcement.update({ where: { id }, data: { sortOrder: i } })));
    await this.revalidate.content();
    return this.listAnnouncements();
  }

  // ---------- pages & SEO ----------
  /** Public: content and SEO for one page. Missing rows are fine; the site falls back to its built-in defaults. */
  async getPage(key: PageKey) {
    const p = await this.prisma.page.findUnique({ where: { key } });
    return {
      key,
      content: (p?.content ?? {}) as Record<string, unknown>,
      seo: { title: p?.seoTitle ?? null, description: p?.seoDescription ?? null, imageUrl: p?.seoImageUrl ?? null, canonicalUrl: p?.canonicalUrl ?? null, noIndex: p?.noIndex ?? false },
    };
  }

  async listPages() {
    return { pages: await Promise.all(PAGE_KEYS.map((k) => this.getPage(k))) };
  }

  async savePage(key: PageKey, body: { content: unknown; seo: unknown }) {
    const content = pageContent[key].safeParse(body.content);
    const seo = seoSchema.safeParse(body.seo);
    if (!content.success || !seo.success) {
      // Surface both sets of problems at once, with paths the form can attach to fields.
      const issues = [
        ...(content.success ? [] : content.error.issues.map((i) => ({ path: ['content', ...i.path].join('.'), message: i.message }))),
        ...(seo.success ? [] : seo.error.issues.map((i) => ({ path: ['seo', ...i.path].join('.'), message: i.message }))),
      ];
      throw new BadRequestException({ message: 'Validation failed', details: issues });
    }
    const s = seo.data as SeoInput;
    const data = { content: content.data as Prisma.InputJsonObject, seoTitle: s.title, seoDescription: s.description, seoImageUrl: s.imageUrl, canonicalUrl: s.canonicalUrl, noIndex: s.noIndex };
    await this.prisma.page.upsert({ where: { key }, update: data, create: { key, ...data } });
    await this.revalidate.content();
    return this.getPage(key);
  }

  // ---------- site settings ----------
  async getSettings() {
    const s = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' }, include: { paymentQr: true } });
    if (!s) throw new NotFoundException('Settings not initialised. Run the seed.');
    return {
      restaurantName: s.restaurantName, phone: s.phone, email: s.email, address: s.address,
      openingHours: s.openingHours, socialLinks: s.socialLinks, taxRateBps: s.taxRateBps,
      pickupEnabled: s.pickupEnabled, dineInEnabled: s.dineInEnabled, deliveryEnabled: s.deliveryEnabled, ordersOpen: s.ordersOpen, cartEnabled: s.cartEnabled,
      paymentQrId: s.paymentQrId, paymentQrUrl: s.paymentQr?.url ?? null, paymentQrAlt: s.paymentQr?.altText ?? '',
      paymentHandle: s.paymentHandle, paymentInstructions: s.paymentInstructions,
    };
  }

  async saveSettings(input: SettingsInput) {
    await this.assertImage(input.paymentQrId);
    // deliveryEnabled is intentionally not settable: delivery needs address handling and fees first.
    await this.prisma.siteSettings.update({
      where: { id: 'singleton' },
      data: { ...input, openingHours: input.openingHours as Prisma.InputJsonArray, socialLinks: input.socialLinks as Prisma.InputJsonArray },
    });
    await this.revalidate.content();
    return this.getSettings();
  }

  private async assertImage(id: string | null | undefined) {
    if (id && !(await this.prisma.mediaAsset.findUnique({ where: { id } }))) throw new BadRequestException('That image no longer exists');
  }
}
