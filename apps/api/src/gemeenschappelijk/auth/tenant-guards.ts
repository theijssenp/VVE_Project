/**
 * DI-schillen om de F08-guards — bedrading voor tenant-scoped controllers.
 *
 * `AuthGuard`/`TenantGuard`/`RolGuard` nemen hun configuratie via de
 * constructor aan (prettig om te testen, niet iets wat Nest kan samenstellen:
 * `AuthGuardsConfig` is een interface). `SessieGuard` is al het DI-omslag van
 * stap 1; dit bestand voegt de schillen van stap 2 en 3 toe, zodat een
 * tenant-scoped controller de volledige §7.5-keten in één `UseGuards` zet:
 *
 *     @UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
 *
 * De verdeling: SessieGuard verifieert het token en zet `inlogContext`;
 * TenantSessieGuard eist de `vve_id`-claim en een lopende rol_toewijzing;
 * RolSessieGuard toetst de `@VereistRecht`-declaratie (deny by default).
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../../database/database.module.js';
import { maakGuards, TenantGuard, RolGuard } from './guards.js';
import { SystemKlok } from '../system-klok.js';

function jwtGeheim(): string {
  const geheim = process.env['JWT_SECRET'];
  if (geheim === undefined || geheim.length < 32) {
    throw new Error('JWT_SECRET ontbreekt of is korter dan 32 tekens (§8.2).');
  }
  return geheim;
}

@Injectable()
export class TenantSessieGuard implements CanActivate {
  readonly #binnen: TenantGuard;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#binnen = maakGuards({ db, jwtGeheim: jwtGeheim(), klok: new SystemKlok() }).tenantGuard;
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.#binnen.canActivate(context);
  }
}

@Injectable()
export class RolSessieGuard implements CanActivate {
  readonly #binnen: RolGuard;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#binnen = maakGuards({ db, jwtGeheim: jwtGeheim(), klok: new SystemKlok() }).rolGuard;
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.#binnen.canActivate(context);
  }
}
