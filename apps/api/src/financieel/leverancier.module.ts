/** Nest-module — leveranciers en verplichtingen (blok A05). */
import { Module } from '@nestjs/common';

import { LeverancierController } from './leverancier.controller.js';

@Module({ controllers: [LeverancierController] })
export class LeverancierModule {}
