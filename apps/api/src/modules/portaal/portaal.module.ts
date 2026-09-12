/** Nest-module — portaal (blok V07). */
import { Module } from '@nestjs/common';

import { PortaalController } from './portaal.controller.js';

@Module({ controllers: [PortaalController] })
export class PortaalModule {}
