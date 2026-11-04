import { Module } from '@nestjs/common';
import { ContentAdminController, PublicPagesController } from './content-admin.controller';
import { ContentAdminService } from './content-admin.service';
import { MenuAdminController } from './menu-admin.controller';
import { MenuAdminService } from './menu-admin.service';

@Module({
  controllers: [MenuAdminController, ContentAdminController, PublicPagesController],
  providers: [MenuAdminService, ContentAdminService],
})
export class CmsModule {}
