import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module.js';
import { BigIntInterceptor } from './gemeenschappelijk/bigint.interceptor.js';
import { HttpFoutFilter } from './gemeenschappelijk/http-fout.filter.js';
import { HealthController } from './modules/health/health.controller.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { MfaController } from './modules/auth/mfa.controller.js';
import { EenhedenController } from './modules/eenheden/eenheden.controller.js';
import { FinancieelController } from './financieel/financieel.controller.js';
import { BegrotingController } from './financieel/begroting.controller.js';
import { BijdrageController } from './financieel/bijdrage.controller.js';
import { NotaController } from './financieel/nota.controller.js';
import { NotaVerzendController } from './financieel/nota-verzend.controller.js';
import { BetalingController } from './financieel/betaling.controller.js';
import { AanmaningController } from './financieel/aanmaning.controller.js';
import { DebiteurenController } from './financieel/debiteuren.controller.js';
import { LeverancierController } from './financieel/leverancier.controller.js';
import { MededelingController } from './financieel/mededeling.controller.js';
import { EigenaarschapController } from './financieel/eigenaarschap.controller.js';
import { UitnodigingenController } from './modules/uitnodigingen/uitnodigingen.controller.js';
import { VerdeelsleutelController } from './financieel/verdeelsleutel.controller.js';
import { VveController } from './modules/vve/vve.controller.js';
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
export const ALLE_CONTROLLERS = [
  HealthController,
  AuthController,
  MfaController,
  VveController,
  EenhedenController,
  UitnodigingenController,
  FinancieelController,
  VerdeelsleutelController,
  BegrotingController,
  BijdrageController,
  NotaController,
  NotaVerzendController,
  BetalingController,
  DebiteurenController,
  AanmaningController,
  LeverancierController,
  MededelingController,
  EigenaarschapController,
];

export async function bootstrap(): Promise<void> {
  // Test #32 (spec §7.5): geen route zonder rechtdeclaratie, vóór er iets luistert.
  controleerRouteDeclaraties(ALLE_CONTROLLERS);
  const app = await NestFactory.create(AppModule);
  // Alles onder /api, zodat Caddy (en de dev-proxy) client en API kunnen scheiden.
  app.setGlobalPrefix('api');
  // Het refresh-token komt als httpOnly-cookie binnen (§7.6).
  app.use(cookieParser());
  // Alle sleutels zijn bigint; zonder dit faalt elk antwoord met een id (§6).
  app.useGlobalInterceptors(new BigIntInterceptor());
  // Eén foutvorm voor de hele API: { code, melding, referentie } (§8.2).
  app.useGlobalFilters(new HttpFoutFilter());
  const port = Number(process.env['PORT'] ?? 3000);

  await app.listen(port);
  Logger.log(
    `VvE-API luistert op http://localhost:${String(port)} (health: GET /api/health)`,
    'Bootstrap',
  );
}

/**
 * Alleen opstarten als dit bestand het startpunt van het proces is.
 *
 * Zonder deze controle start élke import van dit bestand een echte server op
 * poort 3000. De guard-test (test #32) importeert het juist om
 * {@link ALLE_CONTROLLERS} te lezen, en liep daardoor vast op een ontbrekende
 * `DATABASE_URL` — een testfout die niets met de test te maken had. Zelfde
 * patroon als in `database/seeds/beheerder.ts`.
 */
const isStartpunt =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));

if (isStartpunt) {
  bootstrap().catch((error: unknown) => {
    Logger.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      'Bootstrap',
    );
    process.exit(1);
  });
}
