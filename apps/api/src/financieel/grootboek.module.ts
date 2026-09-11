/** Nest-module — grootboek (blok G01). */
import { Module } from '@nestjs/common';

import { GrootboekController } from './grootboek.controller.js';

@Module({ controllers: [GrootboekController] })
export class GrootboekModule {}
