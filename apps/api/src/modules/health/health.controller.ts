import { Controller, Get } from '@nestjs/common';
import { healthResponse, type HealthResponse } from '@vve/contract';

/**
 * Health-endpoint (spec §7.9: health-endpoints + externe uptime-controle).
 *
 * De response wordt met het gedeelde contract-schema uit `@vve/contract` geparseerd:
 * één schema is tegelijk runtime-validatie op de server én het type in de (latere)
 * client. `@vve/contract` is dus geen lucht, maar de drader die de cross-workspace-
 * wiring toetst (F01). Nest serialiseert het teruggekeerde object naar JSON.
 */
@Controller('health')
export class HealthController {
  @Get()
  health(): HealthResponse {
    return healthResponse.parse({ status: 'ok' });
  }
}
