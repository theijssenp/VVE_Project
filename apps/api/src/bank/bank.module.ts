/** Nest-module — bankimport (blok B02). */
import { Module } from '@nestjs/common';

import { BankController } from './bank.controller.js';

@Module({ controllers: [BankController] })
export class BankModule {}
