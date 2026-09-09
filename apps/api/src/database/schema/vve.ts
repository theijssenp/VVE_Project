/**
 * Drizzle-schema — tabel `vve` (spec §6.3).
 *
 * Moet EXACT overeenkomen met `migraties/0002_vve_persoon.sql`. Alleen het DDL
 * daar is leidend; dit bestand is de typeveilige tegenpartij voor de queries uit
 * de repository-laag (spec §7.2).
 *
 * Conventies (spec §6):
 *   - kolomnamen `snake_case` (eerste argument van de kolomfactory = DB-naam),
 *   - bedragen `bigint` in centen (`mode: 'bigint'` -> JS `bigint`),
 *   - primaire sleutel `bigint GENERATED ALWAYS AS IDENTITY`,
 *   - tijdstempels `timestamptz` (kalenderdata `date`, geen tz-conversie).
 *
 * CHECK-constraints staan table-level, zoals de migratie ze op de rij zet.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { modelreglement, vveStatus } from './enums.js';

export const vve = pgTable(
  'vve',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    naam: text('naam').notNull(),
    kvkNummer: text('kvk_nummer').unique(),
    straat: text('straat'),
    huisnummer: text('huisnummer'),
    postcode: text('postcode'),
    plaats: text('plaats'),
    splitsingsdatum: date('splitsingsdatum'),
    modelreglement: modelreglement('modelreglement'),
    breukdeelNoemer: integer('breukdeel_noemer').notNull().default(1000),
    boekjaarStartmaand: smallint('boekjaar_startmaand').notNull().default(1),
    herbouwwaardeCent: bigint('herbouwwaarde_cent', { mode: 'bigint' }),
    ibanExploitatie: text('iban_exploitatie'),
    ibanReserve: text('iban_reserve'),
    incassantId: text('incassant_id'),
    logoDocumentId: bigint('logo_document_id', { mode: 'bigint' }),
    betaaltermijnDagen: smallint('betaaltermijn_dagen').notNull().default(14),
    status: vveStatus('status').notNull().default('actief'),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
    gewijzigdOp: timestamp('gewijzigd_op', { withTimezone: true }),
  },
  (table) => [
    check('vve_breukdeel_noemer_positie', sql`${table.breukdeelNoemer} > 0`),
    check(
      'vve_boekjaar_startmaand_terrein',
      sql`${table.boekjaarStartmaand} >= 1 AND ${table.boekjaarStartmaand} <= 12`,
    ),
    check('vve_herbouwwaarde_niet_negatief', sql`${table.herbouwwaardeCent} >= 0`),
  ],
);

export type Vve = typeof vve.$inferSelect;
export type NieuweVve = typeof vve.$inferInsert;
