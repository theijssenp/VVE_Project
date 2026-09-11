/**
 * Dunne DI-schil om {@link AuthGuard} — F11-bedrading.
 *
 * `AuthGuard` krijgt zijn configuratie (databaseverbinding, JWT-geheim, klok)
 * via de constructor, wat prettig is om te testen maar niet iets wat Nest zelf
 * kan samenstellen: `AuthGuardsConfig` is een interface en heeft dus geen
 * injectietoken. Deze klasse haalt de onderdelen op via DI en delegeert.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../../database/database.module.js';
import { AuthGuard } from '../../gemeenschappelijk/auth/guards.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';

function jwtGeheim(): string {
  const geheim = process.env['JWT_SECRET'];
  if (geheim === undefined || geheim.length < 32) {
    throw new Error('JWT_SECRET ontbreekt of is korter dan 32 tekens (§8.2).');
  }
  return geheim;
}

@Injectable()
export class SessieGuard implements CanActivate {
  readonly #binnen: AuthGuard;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#binnen = new AuthGuard({ db, jwtGeheim: jwtGeheim(), klok: new SystemKlok() });
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.#binnen.canActivate(context);
  }
}
