/** Nest-module — wooneenheden (blok V02). */
import { Module } from '@nestjs/common';

import { EenhedenController } from './eenheden.controller.js';

@Module({ controllers: [EenhedenController] })
export class EenhedenModule {}
