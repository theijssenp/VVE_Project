import { Controller, Get } from '@nestjs/common';

import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { healthResponse, type HealthResponse } from '@vve/contract';

/**
 * Health-endpoint (spec §7.9: health-endpoints + externe uptime-controle).
 *
 * De response wordt met het gedeelde contract-schema uit `@vve/contract` geparseerd:
 * één schema is tegelijk runtime-validatie op de server én het type in de (latere)
 * client. `@vve/contract` is dus geen schijnkoppeling, maar de draad die de
 * cross-workspace-wiring toetst (F01). Nest serialiseert het object naar JSON.
 *
 * De `@VereistRecht`-declaratie is verplicht voor elke route (spec §7.5); de
 * opstartcontrole in `main.ts` weigert te starten als er één ontbreekt.
 */
@Controller('health')
export class HealthController {
  @Get()
  @VereistRecht('health.lezen')
  health(): HealthResponse {
    return healthResponse.parse({ status: 'ok' });
  }
}
