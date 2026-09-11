/**
 * Drizzle-schema — tabellen `verdeelsleutel` en `verdeelsleutel_regel`
 * (spec §6.5).
 *
 * Moet EXACT overeenkomen met migratie 0015. Alleen het DDL daar is leidend.
 * `gewicht` is numeric(14,4) met `mode: 'number'`; de historisering (AC4.5)
 * loopt via `versie` + `actief` op de moeder-tabel.
 */

import { bigint, boolean, index, numeric, pgTable, smallint, text } from 'drizzle-orm/pg-core';

import { vve } from './vve.js';
import { verdeelsleutelType } from './enums.js';
import { wooneenheid } from './wooneenheid.js';

export const verdeelsleutel = pgTable(
  'verdeelsleutel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    naam: text('naam').notNull(),
    type: verdeelsleutelType('type').notNull(),
    versie: smallint('versie').notNull().default(1),
    actief: boolean('actief').notNull().default(true),
    omschrijving: text('omschrijving'),
  },
  (tabel) => [index('ix_vsleutel_vve').on(tabel.vveId)],
);

export const verdeelsleutelRegel = pgTable(
  'verdeelsleutel_regel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    verdeelsleutelId: bigint('verdeelsleutel_id', { mode: 'bigint' })
      .notNull()
      .references(() => verdeelsleutel.id, { onDelete: 'cascade' }),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' })
      .notNull()
      .references(() => wooneenheid.id),
    gewicht: numeric('gewicht', { precision: 14, scale: 4, mode: 'number' }).notNull().default(0),
  },
  (tabel) => [index('ix_vsleutel_regel').on(tabel.verdeelsleutelId)],
);

export type Verdeelsleutel = typeof verdeelsleutel.$inferSelect;
export type NieuweVerdeelsleutel = typeof verdeelsleutel.$inferInsert;
export type VerdeelsleutelRegel = typeof verdeelsleutelRegel.$inferSelect;
export type NieuweVerdeelsleutelRegel = typeof verdeelsleutelRegel.$inferInsert;
