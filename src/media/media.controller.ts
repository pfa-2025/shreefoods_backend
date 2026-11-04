import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AdminAuthGuard, Roles } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AltTextInput, MAX_UPLOAD_BYTES, MediaService, altTextSchema } from './media.service';
import { LocalStorage, StorageProvider } from './storage';

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } }); // memory storage: validated before anything is written

/** Owner-only: uploads become public website content. */
@Controller('admin/media')
@UseGuards(AdminAuthGuard)
@Roles('OWNER')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list() {
    return this.media.list();
  }

  @Post()
  @UseInterceptors(upload)
  create(@UploadedFile() file: Express.Multer.File | undefined, @Body(new ZodValidationPipe(altTextSchema)) body: AltTextInput) {
    return this.media.upload(file, body);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body(new ZodValidationPipe(altTextSchema)) body: AltTextInput) {
    return this.media.updateAlt(id, body);
  }

  @Put(':id/file')
  @UseInterceptors(upload)
  replace(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.media.replace(id, file);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.media.remove(id);
  }
}

/** Public file serving for the local-disk driver. Cloudinary files are served by Cloudinary itself. */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: StorageProvider) {}

  @Get(':key')
  file(@Param('key') key: string, @Res() res: Response): void {
    if (!(this.storage instanceof LocalStorage) || !LocalStorage.KEY_PATTERN.test(key)) throw new NotFoundException();
    const mime = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    res.sendFile(key, {
      root: this.storage.dir,
      dotfiles: 'deny',
      headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ statusCode: 404, error: 'NOT_FOUND', message: 'Not found' });
    });
  }
}
