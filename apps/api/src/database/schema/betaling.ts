/**
 * Drizzle-schema — tabellen `betaling` en `betaling_koppeling` (spec §6.6).
 *
 * Moet EXACT overeenkomen met migratie 0021. Alleen het DDL daar is leidend.
 * `betaling` is het geld-in-komst-artefact; `betaling_koppeling` verdeelt
 * over nota's (bedrag ≠ 0). De openstaand-cent van de nota is afgeleid:
 * nota.bedrag − som(koppelingen). Append-only: corrigeren met
 * een tegengestelde betaling ('verrekening'), nooit met UPDATE/DELETE.
 */

import { bigint, date, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { betalingBron } from './enums.js';
import { nota } from './nota.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';

export const betaling = pgTable(
  'betaling',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' }).references(() => wooneenheid.id),
    datum: date('datum').notNull(),
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
    bron: betalingBron('bron').notNull(),
    omschrijving: text('omschrijving'),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_betaling_eenheid').on(tabel.wooneenheidId, tabel.datum)],
);

export const betalingKoppeling = pgTable(
  'betaling_koppeling',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    betalingId: bigint('betaling_id', { mode: 'bigint' })
      .notNull()
      .references(() => betaling.id, { onDelete: 'cascade' }),
    notaId: bigint('nota_id', { mode: 'bigint' })
      .notNull()
      .references(() => nota.id),
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
  },
  (tabel) => [index('ix_betaling_koppeling_nota').on(tabel.notaId)],
);

export type Betaling = typeof betaling.$inferSelect;
export type NieuweBetaling = typeof betaling.$inferInsert;
export type BetalingKoppeling = typeof betalingKoppeling.$inferSelect;
export type NieuweBetalingKoppeling = typeof betalingKoppeling.$inferInsert;
