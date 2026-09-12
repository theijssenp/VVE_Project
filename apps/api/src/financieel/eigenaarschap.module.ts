/** Nest-module — eigenaarschap (blok V03). */
import { Module } from '@nestjs/common';

import { EigenaarschapController } from './eigenaarschap.controller.js';

@Module({ controllers: [EigenaarschapController] })
export class EigenaarschapModule {}
