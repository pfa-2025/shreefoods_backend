import path from 'node:path';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaController, UploadsController } from './media.controller';
import { MediaService } from './media.service';
import { CloudinaryStorage, LocalStorage, StorageProvider } from './storage';

@Global()
@Module({
  controllers: [MediaController, UploadsController],
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageProvider => {
        const cloud = config.get<string>('CLOUDINARY_CLOUD_NAME');
        const key = config.get<string>('CLOUDINARY_API_KEY');
        const secret = config.get<string>('CLOUDINARY_API_SECRET');
        const log = new Logger('Media');
        if (cloud && key && secret) {
          log.log('Image storage: Cloudinary');
          return new CloudinaryStorage(cloud, key, secret);
        }
        log.warn('Image storage: LOCAL DISK (development only). Configure Cloudinary before launch.');
        return new LocalStorage(path.resolve(config.getOrThrow<string>('UPLOAD_DIR')));
      },
    },
    MediaService,
  ],
  exports: [StorageProvider, MediaService],
})
export class MediaModule {}
