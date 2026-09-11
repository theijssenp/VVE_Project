/**
 * Drizzle-schema — tabellen `nota` en `nota_regel` (spec §6.6).
 *
 * Moet EXACT overeenkomen met migratie 0019. Alleen het DDL daar is leidend.
 * `betalingskenmerk` is de afletter-spil (AC7.4-stap 1); nummer en kenmerk
 * zijn uniek per VvE. De statusflow loopt concept → open → deels_betaald →
 * betaald (gecrediteerd/oninbaar zijn uitzonderingspaden van G08/G11).
 */

import { bigint, boolean, date, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { notaStatus, notaType, betaalwijze } from './enums.js';
import { grootboekrekening } from './grootboekrekening.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';
import { boekjaar } from './boekjaar.js';

export const nota = pgTable(
  'nota',
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
    boekjaarId: bigint('boekjaar_id', { mode: 'bigint' })
      .notNull()
      .references(() => boekjaar.id),
    nummer: text('nummer').notNull(),
    type: notaType('type').notNull(),
    periodeVan: date('periode_van'),
    periodeTot: date('periode_tot'),
    factuurdatum: date('factuurdatum').notNull(),
    vervaldatum: date('vervaldatum').notNull(),
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
    openstaandCent: bigint('openstaand_cent', { mode: 'number' }).notNull(),
    betaalwijze: betaalwijze('betaalwijze').notNull().default('overboeking'),
    betalingskenmerk: text('betalingskenmerk').notNull(),
    status: notaStatus('status').notNull().default('concept'),
    verzondenOp: timestamp('verzonden_op', { withTimezone: true }),
    pdfDocumentId: bigint('pdf_document_id', { mode: 'bigint' }),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [
    index('ix_nota_eenheid_status').on(tabel.wooneenheidId, tabel.status),
    index('ix_nota_openstaand').on(tabel.vveId, tabel.vervaldatum),
  ],
);

export const notaRegel = pgTable(
  'nota_regel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    notaId: bigint('nota_id', { mode: 'bigint' })
      .notNull()
      .references(() => nota.id, { onDelete: 'cascade' }),
    omschrijving: text('omschrijving').notNull(),
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
    grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' })
      .notNull()
      .references(() => grootboekrekening.id),
    isReservefonds: boolean('is_reservefonds').notNull().default(false),
  },
  (tabel) => [index('ix_nota_regel_nota').on(tabel.notaId)],
);

export type Nota = typeof nota.$inferSelect;
export type NieuweNota = typeof nota.$inferInsert;
export type NotaRegel = typeof notaRegel.$inferSelect;
export type NieuweNotaRegel = typeof notaRegel.$inferInsert;
