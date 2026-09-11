/** Nest-module — verdeelsleutels (blok G03). */
import { Module } from '@nestjs/common';

import { VerdeelsleutelController } from './verdeelsleutel.controller.js';

@Module({ controllers: [VerdeelsleutelController] })
export class VerdeelsleutelModule {}
