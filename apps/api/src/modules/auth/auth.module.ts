/** Auth-module — bindt de controller en de sessieguard aan de databaseverbinding. */
import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { SessieGuard } from './sessie.guard.js';

@Module({
  controllers: [AuthController],
  providers: [SessieGuard],
})
export class AuthModule {}
