import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Bootstrap voor de VvE-API (spec §7.1 NestJS 11).
 *
 * De luisterpoort komt uit de omgevingvariabele `PORT` (default 3000), zodat de
 * CI en de lokale dev-omgeving er niet op vastlopen.
 */
export async function bootstrap(): Promise<void> {
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
