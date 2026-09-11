/**
 * Drizzle-schema — tabel `sepa_machtiging` (spec §6.5).
 *
 * Moet EXACT overeenkomen met migratie 0017. Alleen het DDL daar is leidend.
 * Het §6.2-drieluik (iban_versleuteld bytea, iban_hmac bytea indexeerbaar,
 * iban_masker text, sleutel_versie smallint) wordt door de crypto-module
 * (`bank/iban-versleuteling.ts`) gevuld; niemand schrijft deze kolommen
 * rechtstreeks.
 */

import {
  bigint,
  boolean,
  char,
  date,
  index,
  inet,
  pgTable,
  smallint,
  text,
} from 'drizzle-orm/pg-core';

import { machtigingStatus, machtigingType } from './enums.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';

export const sepaMachtiging = pgTable(
  'sepa_machtiging',
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
    kenmerk: text('kenmerk').notNull(),
    ibanVersleuteld: text('iban_versleuteld').notNull().$type<Buffer>(),
    ibanHmac: text('iban_hmac').notNull().$type<Buffer>(),
    ibanMasker: text('iban_masker').notNull(),
    sleutelVersie: smallint('sleutel_versie').notNull().default(1),
    bic: text('bic'),
    tenaamstelling: text('tenaamstelling').notNull(),
    type: machtigingType('type').notNull().default('CORE'),
    ondertekendOp: date('ondertekend_op').notNull(),
    ondertekendIp: inet('ondertekend_ip'),
    machtigingstekstHash: char('machtigingstekst_hash', { length: 64 }),
    eersteIncassoGedaan: boolean('eerste_incasso_gedaan').notNull().default(false),
    vorigKenmerk: text('vorig_kenmerk'),
    vorigIbanMasker: text('vorig_iban_masker'),
    vorigIncassantId: text('vorig_incassant_id'),
    status: machtigingStatus('status').notNull().default('actief'),
    stornoTeller: smallint('storno_teller').notNull().default(0),
    ingetrokkenOp: date('ingetrokken_op'),
  },
  (tabel) => [
    index('ix_machtiging_iban').on(tabel.ibanHmac),
    index('ix_machtiging_vve').on(tabel.vveId),
  ],
);

export type SepaMachtiging = typeof sepaMachtiging.$inferSelect;
export type NieuweSepaMachtiging = typeof sepaMachtiging.$inferInsert;
