/** VvE-module — blok V01. */
import { Module } from '@nestjs/common';

import { SessieGuard } from '../auth/sessie.guard.js';
import { VveController } from './vve.controller.js';

@Module({
  controllers: [VveController],
  providers: [SessieGuard],
})
export class VveModule {}
