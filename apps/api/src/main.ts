import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { controleerRouteDeclaraties } from './gemeenschappelijk/auth/route-inventaris.js';

/**
 * Bootstrap voor de VvE-API (spec §7.1 NestJS 11).
 *
 * De luisterpoort komt uit de omgevingvariabele `PORT` (default 3000), zodat de
 * CI en de lokale dev-omgeving er niet op vastlopen.
 */
/**
 * Alle controllers van de applicatie. Een nieuwe module voegt zijn controller
 * hier toe; de opstartcontrole leest daaruit de werkelijke routes.
 */
export const ALLE_CONTROLLERS = [HealthController];

export async function bootstrap(): Promise<void> {
  // Test #32 (spec §7.5): geen route zonder rechtdeclaratie, vóór er iets luistert.
  controleerRouteDeclaraties(ALLE_CONTROLLERS);
  const app = await NestFactory.create(HealthModule);
  const port = Number(process.env['PORT'] ?? 3000);

  await app.listen(port);
  Logger.log(
    `VvE-API luistert op http://localhost:${String(port)} (health: GET /health)`,
    'Bootstrap',
  );
}

// De e2e-test importeert `health.module.js` rechtstreeks (niet dit bestand),
// dus is dit de enige plek waar de luister-service wordt opgestart.
bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
    'Bootstrap',
  );
  process.exit(1);
});
