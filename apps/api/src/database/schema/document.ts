/**
 * Drizzle-schema — tabel `document` (spec §6.9 · M3 · AC3.1–3.7).
 *
 * Moet EXACT overeenkomen met migratie 0025. Alleen het DDL daar is leidend.
 * De bytes staan op schijf onder een UUID-naam (AC3.7); de database bewaart
 * het relatieve `opslagPad`, de originele naam en het server-side bepaalde
 * MIME-type. Versiebeheer is een gelinkte lijst via `eerdereVersieId`.
 */

import { bigint, index, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { zichtbaarheid } from './enums.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';
import { boekjaar } from './boekjaar.js';
import { leverancier } from './leverancier.js';

export const document = pgTable(
  'document',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    categorie: text('categorie').notNull(),
    titel: text('titel').notNull(),
    zichtbaarheid: zichtbaarheid('zichtbaarheid').notNull().default('bestuur'),
    opslagPad: text('opslag_pad').notNull().unique(),
    origineleNaam: text('originele_naam').notNull(),
    mimeType: text('mime_type').notNull(),
    grootteBytes: bigint('grootte_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    boekjaarId: bigint('boekjaar_id', { mode: 'bigint' }).references(() => boekjaar.id),
    leverancierId: bigint('leverancier_id', { mode: 'bigint' }).references(() => leverancier.id),
    jaar: smallint('jaar'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    eerdereVersieId: bigint('eerdere_versie_id', { mode: 'bigint' }).references(
      (): AnyPgColumn => document.id,
    ),
    versie: integer('versie').notNull().default(1),
    vervallenOp: timestamp('vervallen_op', { withTimezone: true }),
    geuploadDoor: bigint('geupload_door', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [
    index('ix_document_vve').on(tabel.vveId, tabel.zichtbaarheid),
    index('ix_document_eerdere').on(tabel.eerdereVersieId),
  ],
);

export type Document = typeof document.$inferSelect;
export type NieuwDocument = typeof document.$inferInsert;
