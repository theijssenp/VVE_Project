/**
 * Drizzle-schema — tabel `pdf_document` (spec §6.6 · AC13.5).
 *
 * Moet EXACT overeenkomen met migratie 0020. Alleen het DDL daar is leidend.
 * De PDF als bytes in de db: de bewijslast bij aanmaningen (AC13.5) hoort bij
 * het dossier, niet bij een bestandsserver die meeverhuist.
 */

import { bigint, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { vve } from './vve.js';
import { bytea } from './types.js';

export const pdfDocument = pgTable(
  'pdf_document',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    soort: text('soort').notNull(),
    bestandsnaam: text('bestandsnaam').notNull(),
    inhoud: bytea('inhoud').notNull(),
    grootteBytes: bigint('grootte_bytes', { mode: 'number' }).notNull(),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('pdf_document_grootte_niet_negatief', sql`${table.grootteBytes} >= 0`)],
);

export type PdfDocument = typeof pdfDocument.$inferSelect;
export type NieuwPdfDocument = typeof pdfDocument.$inferInsert;
