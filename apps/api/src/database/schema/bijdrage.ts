/**
 * Drizzle-schema — tabellen `bijdrage_schema` en `bijdrage_regel` (spec §6.5).
 *
 * Moet EXACT overeenkomen met migratie 0018. Alleen het DDL daar is leidend.
 * De kolommen `exploitatie_cent`/`reservefonds_cent` zijn bigint-centen met
 * `mode: 'number'` (domein van F05); de split volgt §5.3.
 */

import { bigint, check, date, index, pgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bijdrageBron, bijdrageMethode, begrotingStatus, periodiciteit } from './enums.js';
import { vve } from './vve.js';
import { boekjaar } from './boekjaar.js';
import { wooneenheid } from './wooneenheid.js';

export const bijdrageSchema = pgTable(
  'bijdrage_schema',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    boekjaarId: bigint('boekjaar_id', { mode: 'bigint' })
      .notNull()
      .references(() => boekjaar.id),
    methode: bijdrageMethode('methode').notNull(),
    periodiciteit: periodiciteit('periodiciteit').notNull().default('maand'),
    ingangsdatum: date('ingangsdatum').notNull(),
    status: begrotingStatus('status').notNull().default('concept'),
  },
  (tabel) => [index('ix_bijdrage_schema_vve').on(tabel.vveId)],
);

export const bijdrageRegel = pgTable(
  'bijdrage_regel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    bijdrageSchemaId: bigint('bijdrage_schema_id', { mode: 'bigint' })
      .notNull()
      .references(() => bijdrageSchema.id, { onDelete: 'cascade' }),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' })
      .notNull()
      .references(() => wooneenheid.id),
    exploitatieCent: bigint('exploitatie_cent', { mode: 'number' }).notNull().default(0),
    reservefondsCent: bigint('reservefonds_cent', { mode: 'number' }).notNull().default(0),
    bron: bijdrageBron('bron').notNull().default('berekend'),
  },
  (tabel) => [
    check('bijdrage_regel_exploitatie_niet_negatief', sql`${tabel.exploitatieCent} >= 0`),
    check('bijdrage_regel_reservefonds_niet_negatief', sql`${tabel.reservefondsCent} >= 0`),
    index('ix_bijdrage_regel_schema').on(tabel.bijdrageSchemaId),
  ],
);

export type BijdrageSchema = typeof bijdrageSchema.$inferSelect;
export type NieuwBijdrageSchema = typeof bijdrageSchema.$inferInsert;
export type BijdrageRegel = typeof bijdrageRegel.$inferSelect;
export type NieuwBijdrageRegel = typeof bijdrageRegel.$inferInsert;
