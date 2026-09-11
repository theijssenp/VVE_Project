/**
 * Drizzle-schema — tabel `boekjaar` (spec §6.7).
 *
 * Moet EXACT overeenkomen met migratie 0014. Alleen het DDL daar is leidend.
 * Status-flow: concept → open → afgesloten (enum `boekjaar_status` uit 0001).
 */

import { bigint, check, date, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { boekjaarStatus } from './enums.js';
import { vve } from './vve.js';

export const boekjaar = pgTable(
  'boekjaar',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    jaar: smallint('jaar').notNull(),
    startDatum: date('start_datum').notNull(),
    eindDatum: date('eind_datum').notNull(),
    status: boekjaarStatus('status').notNull().default('concept'),
    afgeslotenOp: timestamp('afgesloten_op', { withTimezone: true }),
  },
  (tabel) => [check('boekjaar_eind_na_start', sql`${tabel.eindDatum} > ${tabel.startDatum}`)],
);

export type Boekjaar = typeof boekjaar.$inferSelect;
export type NieuwBoekjaar = typeof boekjaar.$inferInsert;
