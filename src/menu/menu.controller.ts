import { Controller, Get } from '@nestjs/common';
import { MenuService, PublicMenuCategory } from './menu.service';

@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  async list(): Promise<{ categories: PublicMenuCategory[] }> {
    return { categories: await this.menu.getPublicMenu() };
  }
}
