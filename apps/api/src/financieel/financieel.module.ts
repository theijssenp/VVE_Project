/** Nest-module — financieel: boekjaar, boekingsservice (G02) en balansen (B07). */
import { Module } from '@nestjs/common';

import { BalansController } from './balans.controller.js';
import { FinancieelController } from './financieel.controller.js';

@Module({ controllers: [FinancieelController, BalansController] })
export class FinancieelModule {}
