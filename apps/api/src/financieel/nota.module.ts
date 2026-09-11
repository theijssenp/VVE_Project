/** Nest-module — nota's (blok G06). */
import { Module } from '@nestjs/common';

import { NotaController } from './nota.controller.js';

@Module({ controllers: [NotaController] })
export class NotaModule {}
