/**
 * Kascommissie-verklaring — blok B10 (spec §9 · AC9.7).
 *
 * Eén rij per commissielid per boekjaar: twee leden die los van elkaar
 * aftekenen is de normale gang van zaken (uniek op boekjaar + persoon).
 */
import { bigint, boolean, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { boekjaar } from './boekjaar.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';

export const kascommissieVerklaring = pgTable(
  'kascommissie_verklaring',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id, { onDelete: 'cascade' }),
    boekjaarId: bigint('boekjaar_id', { mode: 'bigint' })
      .notNull()
      .references(() => boekjaar.id, { onDelete: 'cascade' }),
    persoonId: bigint('persoon_id', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    /** Expliciet naast de bevindingen: bezwaar is iets anders dan aftekenen. */
    akkoord: boolean('akkoord').notNull(),
    bevindingen: text('bevindingen'),
    getekendOp: timestamp('getekend_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('kascommissie_verklaring_boekjaar_persoon').on(table.boekjaarId, table.persoonId),
  ],
);
