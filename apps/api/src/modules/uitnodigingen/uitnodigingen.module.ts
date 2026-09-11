/** Nest-module — uitnodigingen (blok V04). */
import { Module } from '@nestjs/common';

import { UitnodigingenController } from './uitnodigingen.controller.js';

@Module({ controllers: [UitnodigingenController] })
export class UitnodigingenModule {}
