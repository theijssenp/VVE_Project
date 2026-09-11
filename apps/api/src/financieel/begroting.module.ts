/** Nest-module — begroting (blok G04). */
import { Module } from '@nestjs/common';

import { BegrotingController } from './begroting.controller.js';

@Module({ controllers: [BegrotingController] })
export class BegrotingModule {}
