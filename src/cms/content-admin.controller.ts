import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, Roles } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AnnouncementInput, AnnouncementPatch, IdListInput, PageKey, SettingsInput,
  announcementPatch, announcementSchema, idList, pageKey, settingsSchema,
} from './cms.schemas';
import { ContentAdminService } from './content-admin.service';

/** Everything that changes what the public sees or what customers pay is owner-only. */
@Controller('admin')
@UseGuards(AdminAuthGuard)
@Roles('OWNER')
export class ContentAdminController {
  constructor(private readonly content: ContentAdminService) {}

  @Get('announcements')
  listAnnouncements() {
    return this.content.listAnnouncements();
  }
  @Post('announcements')
  createAnnouncement(@Body(new ZodValidationPipe(announcementSchema)) b: AnnouncementInput) {
    return this.content.createAnnouncement(b);
  }
  @Put('announcements/order')
  reorderAnnouncements(@Body(new ZodValidationPipe(idList)) b: IdListInput) {
    return this.content.reorderAnnouncements(b);
  }
  @Patch('announcements/:id')
  updateAnnouncement(@Param('id') id: string, @Body(new ZodValidationPipe(announcementPatch)) b: AnnouncementPatch) {
    return this.content.updateAnnouncement(id, b);
  }

  @Get('pages')
  listPages() {
    return this.content.listPages();
  }
  @Put('pages/:key')
  savePage(@Param('key', new ZodValidationPipe(pageKey)) key: PageKey, @Body() body: { content: unknown; seo: unknown }) {
    return this.content.savePage(key, body ?? {});
  }

  @Get('settings')
  settings() {
    return this.content.getSettings();
  }
  @Put('settings')
  saveSettings(@Body(new ZodValidationPipe(settingsSchema)) b: SettingsInput) {
    return this.content.saveSettings(b);
  }
}

/** Public page content + SEO overrides for the website. */
@Controller('pages')
export class PublicPagesController {
  constructor(private readonly content: ContentAdminService) {}

  @Get(':key')
  get(@Param('key') key: string) {
    const parsed = pageKey.safeParse(key);
    if (!parsed.success) throw new NotFoundException('Page not found');
    return this.content.getPage(parsed.data);
  }
}
