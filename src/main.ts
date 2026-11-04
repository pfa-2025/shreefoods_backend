import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}/api/v1`);
}

void bootstrap();
