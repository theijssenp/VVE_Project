/** Nest-module — documenten (blok V05). */
import { Module } from '@nestjs/common';

import { DocumentenController } from './documenten.controller.js';

@Module({ controllers: [DocumentenController] })
export class DocumentenModule {}
