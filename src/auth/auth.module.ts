import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AdminAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AdminAuthGuard], // PasswordResetNotifier comes from the global EmailModule
  exports: [AuthService, AdminAuthGuard],
})
export class AuthModule {}
