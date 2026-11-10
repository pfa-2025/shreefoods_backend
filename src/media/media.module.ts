import path from 'node:path';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaController, UploadsController } from './media.controller';
import { MediaService } from './media.service';
import { CloudinaryStorage, LocalStorage, R2Storage, StorageProvider } from './storage';

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
        const r2 = {
          endpoint: config.get<string>('R2_ENDPOINT'),
          accessKeyId: config.get<string>('R2_ACCESS_KEY_ID'),
          secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY'),
          bucket: config.get<string>('R2_BUCKET'),
          publicUrl: config.get<string>('R2_PUBLIC_URL'),
        };
        if (r2.endpoint && r2.accessKeyId && r2.secretAccessKey && r2.bucket && r2.publicUrl) {
          log.log(`Image storage: Cloudflare R2 (bucket ${r2.bucket})`);
          return new R2Storage({ endpoint: r2.endpoint, accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, bucket: r2.bucket, publicUrl: r2.publicUrl });
        }
        if (cloud && key && secret) {
          log.log('Image storage: Cloudinary');
          return new CloudinaryStorage(cloud, key, secret);
        }
        log.warn('Image storage: LOCAL DISK (development only). Configure Cloudflare R2 before launch.');
        return new LocalStorage(path.resolve(config.getOrThrow<string>('UPLOAD_DIR')));
      },
    },
    MediaService,
  ],
  exports: [StorageProvider, MediaService],
})
export class MediaModule {}
