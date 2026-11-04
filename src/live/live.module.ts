import { Global, Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveEventsService } from './live-events.service';

@Global()
@Module({ controllers: [LiveController], providers: [LiveEventsService], exports: [LiveEventsService] })
export class LiveModule {}
