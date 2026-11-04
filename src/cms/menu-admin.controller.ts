import { Body, Controller, HttpCode, Param, Patch, Post, Put, Get, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, Roles } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CategoryInput, CategoryPatch, IdListInput, ItemInput, ItemOrderInput, ItemPatch,
  availabilitySchema, categoryPatch, categorySchema, idList, itemOrderSchema, itemPatch, itemSchema,
} from './cms.schemas';
import { MenuAdminService } from './menu-admin.service';

/** Owner-only, except flipping availability ("we're out of X"), which any signed-in staff may do. */
@Controller('admin/menu')
@UseGuards(AdminAuthGuard)
@Roles('OWNER')
export class MenuAdminController {
  constructor(private readonly menu: MenuAdminService) {}

  @Get()
  @Roles('OWNER', 'STAFF')
  list() {
    return this.menu.list();
  }

  @Post('categories')
  createCategory(@Body(new ZodValidationPipe(categorySchema)) b: CategoryInput) {
    return this.menu.createCategory(b);
  }
  @Put('categories/order')
  reorderCategories(@Body(new ZodValidationPipe(idList)) b: IdListInput) {
    return this.menu.reorderCategories(b);
  }
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body(new ZodValidationPipe(categoryPatch)) b: CategoryPatch) {
    return this.menu.updateCategory(id, b);
  }

  @Post('items')
  createItem(@Body(new ZodValidationPipe(itemSchema)) b: ItemInput) {
    return this.menu.createItem(b);
  }
  @Put('items/order')
  reorderItems(@Body(new ZodValidationPipe(itemOrderSchema)) b: ItemOrderInput) {
    return this.menu.reorderItems(b);
  }
  @Patch('items/:id')
  updateItem(@Param('id') id: string, @Body(new ZodValidationPipe(itemPatch)) b: ItemPatch) {
    return this.menu.updateItem(id, b);
  }
  @Post('items/:id/duplicate')
  @HttpCode(201)
  duplicate(@Param('id') id: string) {
    return this.menu.duplicateItem(id);
  }
  @Patch('items/:id/availability')
  @Roles('OWNER', 'STAFF')
  availability(@Param('id') id: string, @Body(new ZodValidationPipe(availabilitySchema)) b: { isAvailable: boolean }) {
    return this.menu.setAvailability(id, b.isAvailable);
  }
}
