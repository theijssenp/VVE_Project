/**
 * Drizzle-schema — leveranciers, contracten en verplichtingen (spec §6.9).
 *
 * Moet EXACT overeenkomen met migratie 0023. Alleen het DDL daar is leidend.
 * De IBAN van een leverancier volgt het §6.2-drieluik (B01-module); de
 * opzegsignalering (AC12.4: 90 dagen vóór verstrijken) en de
 * verplichtingsherinneringen (T-60/T-14) zijn live gerekend in de service.
 */

import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './types.js';
import { vve } from './vve.js';
import { verplichtingSoort } from './enums.js';

export const leverancier = pgTable('leverancier', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  vveId: bigint('vve_id', { mode: 'bigint' })
    .notNull()
    .references(() => vve.id),
  naam: text('naam').notNull(),
  contactpersoon: text('contactpersoon'),
  email: text('email'),
  telefoon: text('telefoon'),
  ibanVersleuteld: bytea('iban_versleuteld'),
  ibanHmac: bytea('iban_hmac'),
  ibanMasker: text('iban_masker'),
  sleutelVersie: smallint('sleutel_versie').notNull().default(1),
  kvkNummer: text('kvk_nummer'),
  opmerking: text('opmerking'),
  aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
});

export const leverancierContract = pgTable(
  'leverancier_contract',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    leverancierId: bigint('leverancier_id', { mode: 'bigint' })
      .notNull()
      .references(() => leverancier.id, { onDelete: 'cascade' }),
    omschrijving: text('omschrijving').notNull(),
    bedragPerJaarCent: bigint('bedrag_per_jaar_cent', { mode: 'number' }).notNull(),
    startDatum: date('start_datum').notNull(),
    eindDatum: date('eind_datum'),
    opzegtermijnDagen: integer('opzegtermijn_dagen').notNull().default(60),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_contract_eind').on(tabel.vveId, tabel.eindDatum)],
);

export const verplichting = pgTable(
  'verplichting',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    leverancierId: bigint('leverancier_id', { mode: 'bigint' }).references(() => leverancier.id),
    soort: verplichtingSoort('soort').notNull(),
    omschrijving: text('omschrijving').notNull(),
    vervaldatum: date('vervaldatum').notNull(),
    polisDocumentId: bigint('polis_document_id', { mode: 'bigint' }),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [
    index('ix_verplichting_verval').on(tabel.vveId, tabel.vervaldatum),
    check('verplichting_verval_geldig', sql`${tabel.vervaldatum} > DATE '1900-01-01'`),
  ],
);

export type Leverancier = typeof leverancier.$inferSelect;
export type NieuweLeverancier = typeof leverancier.$inferInsert;
export type LeverancierContract = typeof leverancierContract.$inferSelect;
export type NieuwLeverancierContract = typeof leverancierContract.$inferInsert;
export type Verplichting = typeof verplichting.$inferSelect;
export type NieuweVerplichting = typeof verplichting.$inferInsert;
