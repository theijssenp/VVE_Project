/**
 * Drizzle-schema — tabel `grootboekrekening` (spec §6.7).
 *
 * Moet EXACT overeenkomen met migratie 0013. Alleen het DDL daar is leidend.
 * De kolom `verdeelsleutel_id` uit §6.7 komt mee in de migratie van blok G03;
 * hier niet aanroepen — het schema groeit per blok (zie enums.ts).
 */

import { bigint, boolean, index, pgTable, text } from 'drizzle-orm/pg-core';

import { grootboekCategorie } from './enums.js';
import { vve } from './vve.js';

export const grootboekrekening = pgTable(
  'grootboekrekening',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    nummer: text('nummer').notNull(),
    naam: text('naam').notNull(),
    categorie: grootboekCategorie('categorie').notNull(),
    isReservefonds: boolean('is_reservefonds').notNull().default(false),
    actief: boolean('actief').notNull().default(true),
  },
  (tabel) => [index('ix_gboek_vve').on(tabel.vveId)],
);

export type Grootboekrekening = typeof grootboekrekening.$inferSelect;
export type NieuweGrootboekrekening = typeof grootboekrekening.$inferInsert;
