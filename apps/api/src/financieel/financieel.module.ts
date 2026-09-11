/** Nest-module — financieel: boekjaar en boekingsservice (blok G02). */
import { Module } from '@nestjs/common';

import { FinancieelController } from './financieel.controller.js';

@Module({ controllers: [FinancieelController] })
export class FinancieelModule {}
