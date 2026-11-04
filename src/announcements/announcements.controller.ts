import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PublicAnnouncement {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  imageAlt: string;
  linkUrl: string | null;
}

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly prisma: PrismaService) {}

  /** "What's New": published and already-due announcements only. */
  @Get()
  async list(): Promise<{ announcements: PublicAnnouncement[] }> {
    const rows = await this.prisma.announcement.findMany({
      where: { status: 'PUBLISHED', OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { image: true },
    });
    return {
      announcements: rows.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        imageUrl: a.image?.url ?? null,
        imageAlt: a.image?.altText ?? a.title,
        linkUrl: a.linkUrl,
      })),
    };
  }
}
