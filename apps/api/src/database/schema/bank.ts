/**
 * Bankrekeningen, imports en mutaties — blok B02 (§10, AC7.1–7.3).
 *
 * IBAN's staan als §6.2-drieluik: versleuteld, HMAC om op te zoeken zonder te
 * ontsleutelen, en een masker voor op het scherm. De crypto-module
 * (`bank/iban-versleuteling.ts`) vult die kolommen; niemand schrijft ze zelf.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { grootboekrekening } from './grootboekrekening.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';

export const bankrekening = pgTable(
  'bankrekening',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id, { onDelete: 'cascade' }),
    naam: text('naam').notNull(),
    ibanVersleuteld: text('iban_versleuteld').notNull().$type<Buffer>(),
    ibanHmac: text('iban_hmac').notNull().$type<Buffer>(),
    ibanMasker: text('iban_masker').notNull(),
    sleutelVersie: smallint('sleutel_versie').notNull().default(1),
    grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' }).references(
      () => grootboekrekening.id,
    ),
    /** Laatst bekende eindsaldo; hierop toetst AC7.3 de continuïteit. */
    laatsteSaldoCent: bigint('laatste_saldo_cent', { mode: 'number' }),
    laatsteSaldoDatum: date('laatste_saldo_datum'),
    actief: boolean('actief').notNull().default(true),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bankrekening_vve_iban').on(t.vveId, t.ibanHmac)],
);

export const bankImport = pgTable('bank_import', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  vveId: bigint('vve_id', { mode: 'bigint' })
    .notNull()
    .references(() => vve.id, { onDelete: 'cascade' }),
  bankrekeningId: bigint('bankrekening_id', { mode: 'bigint' })
    .notNull()
    .references(() => bankrekening.id, { onDelete: 'cascade' }),
  formaat: text('formaat').notNull(),
  bestandsnaam: text('bestandsnaam'),
  afschriftId: text('afschrift_id'),
  beginsaldoCent: bigint('beginsaldo_cent', { mode: 'number' }).notNull(),
  eindsaldoCent: bigint('eindsaldo_cent', { mode: 'number' }).notNull(),
  beginsaldoDatum: date('beginsaldo_datum'),
  eindsaldoDatum: date('eindsaldo_datum'),
  aantalPosten: integer('aantal_posten').notNull().default(0),
  aantalNieuw: integer('aantal_nieuw').notNull().default(0),
  aantalDuplicaat: integer('aantal_duplicaat').notNull().default(0),
  /** AC7.3: het gat in de continuïteit, of null als het aansloot. */
  continuiteitGatCent: bigint('continuiteit_gat_cent', { mode: 'number' }),
  doorPersoonId: bigint('door_persoon_id', { mode: 'bigint' })
    .notNull()
    .references(() => persoon.id),
  aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
});

export const bankmutatie = pgTable(
  'bankmutatie',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id, { onDelete: 'cascade' }),
    bankrekeningId: bigint('bankrekening_id', { mode: 'bigint' })
      .notNull()
      .references(() => bankrekening.id, { onDelete: 'cascade' }),
    bankImportId: bigint('bank_import_id', { mode: 'bigint' })
      .notNull()
      .references(() => bankImport.id, { onDelete: 'cascade' }),
    boekdatum: date('boekdatum').notNull(),
    valutadatum: date('valutadatum'),
    /** Positief = bij, negatief = af. */
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
    munt: text('munt').notNull().default('EUR'),
    tegenrekeningVersleuteld: text('tegenrekening_versleuteld').$type<Buffer>(),
    tegenrekeningHmac: text('tegenrekening_hmac').$type<Buffer>(),
    tegenrekeningMasker: text('tegenrekening_masker'),
    tegenpartijNaam: text('tegenpartij_naam'),
    omschrijving: text('omschrijving').notNull().default(''),
    eindTotEindId: text('eind_tot_eind_id'),
    bankreferentie: text('bankreferentie'),
    volgnummer: integer('volgnummer').notNull(),
    duplicaatHash: text('duplicaat_hash').notNull().$type<Buffer>(),
    gematchtOp: timestamp('gematcht_op', { withTimezone: true }),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bankmutatie_vve_hash').on(t.vveId, t.duplicaatHash),
    index('ix_bankmutatie_rek_datum').on(t.bankrekeningId, t.boekdatum),
  ],
);
