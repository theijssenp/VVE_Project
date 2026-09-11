/** Nest-module — nota-PDF en verzending (blok G07). */
import { Module } from '@nestjs/common';

import { NotaVerzendController } from './nota-verzend.controller.js';

@Module({ controllers: [NotaVerzendController] })
export class NotaVerzendModule {}
