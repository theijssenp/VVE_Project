/**
 * Drizzle-schema — tabel `gebouw` (spec §6.4).
 *
 * Moet EXACT overeenkomen met `migraties/0010_wooneenheid.sql`. Alleen het DDL
 * daar is leidend; dit bestand is de typeveilige tegenpartij voor de queries
 * uit de service-laag (spec §7.2).
 *
 * Conventies (spec §6): kolomnamen `snake_case`, primaire sleutel `bigint
 * GENERATED ALWAYS AS IDENTITY`, kalenderdata `date` zonder tz-conversie.
 */

import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';

import { vve } from './vve.js';

export const gebouw = pgTable(
  'gebouw',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    naam: text('naam').notNull(),
    adres: text('adres'),
  },
  (table) => [index('gebouw_vve_idx').on(table.vveId)],
);

export type Gebouw = typeof gebouw.$inferSelect;
export type NieuwGebouw = typeof gebouw.$inferInsert;
