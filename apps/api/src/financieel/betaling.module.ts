/** Nest-module — betalingen (blok G08). */
import { Module } from '@nestjs/common';

import { BetalingController } from './betaling.controller.js';

@Module({ controllers: [BetalingController] })
export class BetalingModule {}
