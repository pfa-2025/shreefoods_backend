import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { RevalidateService } from '../revalidate/revalidate.service';
import { sniffImage } from './image-sniff';
import { StorageProvider } from './storage';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const altTextSchema = z.object({ altText: z.string().trim().max(200).default('') });
export type AltTextInput = z.infer<typeof altTextSchema>;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly revalidate: RevalidateService,
  ) {}

  private view(a: { id: string; url: string; altText: string; bytes: number | null; mimeType: string | null; createdAt: Date; _count?: { menuItems: number; announcements: number; settingsQr: number } }) {
    return {
      id: a.id,
      url: a.url,
      altText: a.altText,
      bytes: a.bytes,
      mimeType: a.mimeType,
      createdAt: a.createdAt.toISOString(),
      usage: a._count ? { menuItems: a._count.menuItems, announcements: a._count.announcements, paymentQr: a._count.settingsQr } : undefined,
    };
  }

  private async store(file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose an image to upload');
    const kind = sniffImage(file.buffer); // trust the bytes, not the filename or declared type
    if (!kind) throw new BadRequestException('Only JPEG, PNG and WebP images are allowed');
    const stored = await this.storage.save(file.buffer, kind.ext, kind.mime);
    return { stored, kind, bytes: file.buffer.length };
  }

  async list() {
    const rows = await this.prisma.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { menuItems: true, announcements: true, settingsQr: true } } },
    });
    return { assets: rows.map((r) => this.view(r)), storage: this.storage.name };
  }

  async upload(file: Express.Multer.File | undefined, input: AltTextInput) {
    const { stored, kind, bytes } = await this.store(file);
    try {
      const row = await this.prisma.mediaAsset.create({
        data: { url: stored.url, publicId: stored.key, altText: input.altText, bytes, mimeType: kind.mime },
      });
      return this.view(row);
    } catch (e) {
      await this.storage.remove(stored.key).catch(() => undefined); // don't orphan the file if the row failed
      throw e;
    }
  }

  async updateAlt(id: string, input: AltTextInput) {
    const row = await this.prisma.mediaAsset.update({ where: { id }, data: { altText: input.altText } }).catch(() => null);
    if (!row) throw new NotFoundException('Image not found');
    await this.revalidate.content();
    return this.view(row);
  }

  /** Swap the picture but keep the id, so every place that uses it updates. */
  async replace(id: string, file: Express.Multer.File | undefined) {
    const current = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Image not found');
    const { stored, kind, bytes } = await this.store(file);
    let row;
    try {
      row = await this.prisma.mediaAsset.update({ where: { id }, data: { url: stored.url, publicId: stored.key, bytes, mimeType: kind.mime } });
    } catch (e) {
      await this.storage.remove(stored.key).catch(() => undefined);
      throw e;
    }
    if (current.publicId && !current.publicId.startsWith('seed/')) await this.storage.remove(current.publicId).catch((e: unknown) => this.logger.warn(`Old file not removed: ${String(e)}`));
    await this.revalidate.content();
    return this.view(row);
  }

  /** Safe deletion: an image that is still in use can't be removed. */
  async remove(id: string): Promise<void> {
    const row = await this.prisma.mediaAsset.findUnique({
      where: { id },
      include: { _count: { select: { menuItems: true, announcements: true, settingsQr: true } } },
    });
    if (!row) throw new NotFoundException('Image not found');
    const { menuItems, announcements, settingsQr } = row._count;
    if (menuItems + announcements + settingsQr > 0) {
      const where = [menuItems && `${menuItems} menu item(s)`, announcements && `${announcements} announcement(s)`, settingsQr && 'the payment QR'].filter(Boolean).join(', ');
      throw new ConflictException(`This image is used by ${where}. Replace or remove it there first.`);
    }
    await this.prisma.mediaAsset.delete({ where: { id } });
    // Seeded placeholders point at files bundled with the web app, not at storage.
    if (row.publicId && !row.publicId.startsWith('seed/')) await this.storage.remove(row.publicId).catch((e: unknown) => this.logger.warn(`File not removed: ${String(e)}`));
  }
}
