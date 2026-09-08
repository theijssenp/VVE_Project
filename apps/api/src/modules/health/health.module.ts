import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Root-module van de VvE-API. In F01 bevat alleen de health-module; later groeit
 * dit uit naar de domein-modules (vve, eenheden, financieel, ...) uit spec §7.2.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
