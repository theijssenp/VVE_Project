/** Nest-module — mededelingen en mailsjablonen (blok A06). */
import { Module } from '@nestjs/common';

import { MededelingController } from './mededeling.controller.js';

@Module({ controllers: [MededelingController] })
export class MededelingModule {}
