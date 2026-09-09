/**
 * Drizzle-schema — tabel `rol_toewijzing` (spec §6.3).
 *
 * Moet EXACT overeenkomen met migratie 0005. Koppelt een `persoon` aan een
 * `rol` binnen een `vve` (beide tabellen bestaande sinds migratie 0002).
 *
 * De `CHECK (eind_datum IS NULL OR eind_datum >= start_datum)` wordt
 * table-level gesteld in de migratie; hier staat de identieke
 * table-level constraint in het Drizzle-schema zodat Drizzle-kit (als
 * dat ooit wordt gebruikt) de migratie zou kunnen reproduceren.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';

import { persoon } from './persoon.js';
import { rolType } from './enums.js';
import { vve } from './vve.js';

export const rolToewijzing = pgTable(
  'rol_toewijzing',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    persoonId: bigint('persoon_id', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    rol: rolType('rol').notNull(),
    startDatum: date('start_datum').notNull(),
    eindDatum: date('eind_datum'),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'rol_toewijzing_eind_datum_vanaf_start',
      sql`${table.eindDatum} IS NULL OR ${table.eindDatum} >= ${table.startDatum}`,
    ),
  ],
);

export type RolToewijzing = typeof rolToewijzing.$inferSelect;
export type NieuweRolToewijzing = typeof rolToewijzing.$inferInsert;
