/**
 * Drizzle-schema — tabel `eigenaarschap` (spec §6.4).
 *
 * Moet EXACT overeenkomen met `migraties/0010_wooneenheid.sql`. Alleen het DDL
 * daar is leidend. `periode` is een `daterange`: historische koppeling tussen
 * eenheid en eigenaar. De exclusion constraints uit de migratie (geen dubbel
 * volledig eigendom, geen overlap per eenheid+persoon, geen lege periode)
 * staan table-level in het DDL — Drizzle 0.45 heeft geen first-class bouwstenen
 * voor `EXCLUDE USING gist`, dus die leven alleen in de migratie.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  integer,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';

import { persoon } from './persoon.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';

/** Postgres `daterange` — node-postgres levert/accepteert de tekstvorm 'a/b'. */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'daterange';
  },
});

export const eigenaarschap = pgTable(
  'eigenaarschap',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' })
      .notNull()
      .references(() => wooneenheid.id),
    persoonId: bigint('persoon_id', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    aandeelPromille: integer('aandeel_promille').notNull().default(1000),
    isPrimairContact: boolean('is_primair_contact').notNull().default(false),
    periode: daterange('periode').notNull(),
    akteDatum: date('akte_datum'),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'eigenaarschap_aandeel_0_tot_1000',
      sql`${table.aandeelPromille} >= 0 AND ${table.aandeelPromille} <= 1000`,
    ),
  ],
);

export type Eigenaarschap = typeof eigenaarschap.$inferSelect;
export type NieuwEigenaarschap = typeof eigenaarschap.$inferInsert;
