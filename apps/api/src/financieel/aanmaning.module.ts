/** Nest-module — aanmaningstraject (blok G11). */
import { Module } from '@nestjs/common';

import { AanmaningController } from './aanmaning.controller.js';

@Module({ controllers: [AanmaningController] })
export class AanmaningModule {}
