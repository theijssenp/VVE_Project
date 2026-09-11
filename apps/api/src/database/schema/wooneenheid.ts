/**
 * Drizzle-schema — tabel `wooneenheid` (spec §6.4).
 *
 * Moet EXACT overeenkomen met `migraties/0010_wooneenheid.sql`. Alleen het DDL
 * daar is leidend; dit bestand is de typeveilige tegenpartij voor de queries
 * uit de service-laag (spec §7.2).
 *
 * Conventies (spec §6): kolomnamen `snake_case`, primaire sleutel `bigint
 * GENERATED ALWAYS AS IDENTITY`, kalenderdata `date` zonder tz-conversie.
 * `numeric(10,2)` met `mode: 'number'` levert een JS-getal; de breukdelen en
 * stemmen zijn `integer`, de tenant-sleutel `bigint`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { eenheidType } from './enums.js';
import { gebouw } from './gebouw.js';
import { vve } from './vve.js';

export const wooneenheid = pgTable(
  'wooneenheid',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    gebouwId: bigint('gebouw_id', { mode: 'bigint' }).references(() => gebouw.id),
    code: text('code').notNull(),
    type: eenheidType('type').notNull().default('woning'),
    straat: text('straat'),
    huisnummer: text('huisnummer'),
    huisnummerToevoeging: text('huisnummer_toevoeging'),
    postcode: text('postcode'),
    plaats: text('plaats'),
    bouwlaag: smallint('bouwlaag'),
    oppervlakteM2: numeric('oppervlakte_m2', { precision: 10, scale: 2, mode: 'number' }),
    breukdeelTeller: integer('breukdeel_teller').notNull().default(1),
    breukdeelNoemer: integer('breukdeel_noemer').notNull().default(1000),
    stemmen: integer('stemmen').notNull().default(1),
    kadastraleAanduiding: text('kadastrale_aanduiding'),
    actiefVanaf: date('actief_vanaf'),
    actiefTot: date('actief_tot'),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
    gewijzigdOp: timestamp('gewijzigd_op', { withTimezone: true }),
  },
  (table) => [
    check('wooneenheid_breukdeel_teller_niet_negatief', sql`${table.breukdeelTeller} >= 0`),
    check('wooneenheid_breukdeel_noemer_positief', sql`${table.breukdeelNoemer} > 0`),
    check('wooneenheid_stemmen_niet_negatief', sql`${table.stemmen} >= 0`),
    check('wooneenheid_oppervlakte_niet_negatief', sql`${table.oppervlakteM2} >= 0`),
    check(
      'wooneenheid_breukdeel_binnen_noemer',
      sql`${table.breukdeelTeller} <= ${table.breukdeelNoemer}`,
    ),
  ],
);

export type Wooneenheid = typeof wooneenheid.$inferSelect;
export type NieuweWooneenheid = typeof wooneenheid.$inferInsert;
