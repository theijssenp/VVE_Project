/** Nest-module — bijdrageschema (blok G05). */
import { Module } from '@nestjs/common';

import { BijdrageController } from './bijdrage.controller.js';

@Module({ controllers: [BijdrageController] })
export class BijdrageModule {}
