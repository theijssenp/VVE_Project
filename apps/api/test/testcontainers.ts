/**
 * Testcontainers-harnas — F03 (spec "Testcontainers-harnas", §6.3).
 *
 * Start per testsessie EÉN PostgreSQL-16-container op exact hetzelfde
 * image/digest als `infra/docker-compose.yml` (F02), voert de migratierunner
 * (`migraties-kern.ts`) tegen die verse container uit, en levert een
 * Drizzle-db op via `pg`.
 *
 * De integratietests delen de container via `gedeeldeTestDb()` en
 * stoppen haar in `afterAll`.
 *
 * LET OP: dit bestand wordt gecompileerd door `tsc -b` (apps/api is CJS,
 * `module: NodeNext`), dus géén `import.meta` — die is ESM-only.
 * De migraties-map wordt vanuit de current-working-directory opgelost
 * (de tests draaien vanuit de repo-root via de root-`npm run test`,
 * zie de F01-conventie). De CLI `run-migraties.ts` gebruikt wél
 * `import.meta` en is daarom uitgesloten van `tsc -b`.
 */

import { Client, Pool, type Pool as PgPool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { voerMigratiesUit } from '../src/database/run-migraties.js';

/**
 * Zelfde postgres-image als `infra/docker-compose.yml` (F02), vastgezet op
 * de digest (niet een floating tag) — spec §8.2.
 */
export const POSTGRES_IMAGE =
  'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';

/** Test-identiteiten (geen echt secret — testcontainers draait lokaal). */
export const POSTGRES_DB = 'vve';
export const POSTGRES_USER = 'vve';
export const POSTGRES_PASSWORD = 'vve';

export interface TestPgDb {
  readonly url: string;
  readonly pool: PgPool;
  readonly db: NodePgDatabase;
  readonly container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

let gedeeld: TestPgDb | null = null;

/**
 * Levert de gedeelde (één-per-sessie) gemigreerde test-db terug.
 * Roep `gedeeldeTestDb()` in `beforeAll` aan en stop met `stop()` in `afterAll`.
 */
export async function gedeeldeTestDb(): Promise<TestPgDb> {
  if (gedeeld !== null) return gedeeld;

  const gesteurt = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(POSTGRES_DB)
    .withUsername(POSTGRES_USER)
    .withPassword(POSTGRES_PASSWORD)
    .start();

  const url = gesteurt.getConnectionUri();

  // Verse container => de migratierunner voegt nu wél migraties toe.
  const { uitgevoerde } = await voerMigratiesUit(url);
  if (uitgevoerde.length === 0) {
    throw new Error(
      '[testcontainers] migratierunner voegde geen migraties toe — ' +
        'verwachtte 0001 en 0002. Controleer de migraties-map.',
    );
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  gedeeld = {
    url,
    pool,
    db,
    container: gesteurt,
    stop: async () => {
      await pool.end();
      await gesteurt.stop();
      gedeeld = null;
    },
  };
  return gedeeld;
}

/**
 * Bouwt een connectie-URL naar een ANDERE database in dezelfde container
 * (zelfde host/port/credentials, andere databasenaam). Nuttig om de
 * migratierunner op een lege database te draaien zonder de gedeelde
 * `POSTGRES_DB` te verstoren.
 */
export function urlMetDatabase(basisUrl: string, database: string): string {
  const u = new URL(basisUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Maakt een lege, nog niet-gemigreerde database aan in de gedeelde
 * container en levert de URL ertegen terug.
 */
export async function legeDatabaseUrl(db: TestPgDb, naam: string): Promise<string> {
  const klant = new Client({ connectionString: db.url });
  await klant.connect();
  try {
    await klant.query(`CREATE DATABASE ${naam}`);
  } finally {
    await klant.end();
  }
  return urlMetDatabase(db.url, naam);
}
