/** Nest-module — debiteuren (blok G09). */
import { Module } from '@nestjs/common';

import { DebiteurenController } from './debiteuren.controller.js';

@Module({ controllers: [DebiteurenController] })
export class DebiteurenModule {}
