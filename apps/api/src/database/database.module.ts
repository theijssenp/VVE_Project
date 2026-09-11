/**
 * Databasemodule — levert één Drizzle-instantie aan de rest van de applicatie.
 *
 * De verbinding komt uit `DATABASE_URL`. Er is bewust geen standaardwaarde:
 * een applicatie die stilletjes naar een andere database praat dan bedoeld, is
 * erger dan een die niet start (§8.2).
 *
 * LET OP (§6.9): dit is de gewone applicatieverbinding. Die hoort te draaien
 * als een rol met `vve_app`-lidmaatschap, nooit als eigenaar of superuser —
 * die omzeilen Row-Level Security volledig en maken de policies betekenisloos.
 */
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

function verbindingsUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL ontbreekt; er is bewust geen standaardwaarde.');
  }
  return url;
}

@Global()
@Module({
  providers: [
    { provide: DATABASE_POOL, useFactory: () => new Pool({ connectionString: verbindingsUrl() }) },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): NodePgDatabase => drizzle(pool),
    },
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // Verbindingen netjes sluiten, zodat een herstart niet op een volle pool loopt.
    await Promise.resolve();
  }
}
