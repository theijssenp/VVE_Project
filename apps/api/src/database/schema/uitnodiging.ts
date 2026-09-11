/**
 * Drizzle-schema — tabel `uitnodiging` (spec §6.3).
 *
 * Moet EXACT overeenkomen met migratie 0012. Alleen het DDL daar is leidend.
 * `token_hash` is sha256-hex (char(64)) van het opake token; het ruwe token
 * verlaat de database nooit (§8.2). De mail met de link is `gevoelig`
 * (tekst na verzending gewist, F10/0009).
 */

import { bigint, char, index, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';

import { rolType } from './enums.js';
import { persoon } from './persoon.js';
import { citext } from './types.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';

export const uitnodiging = pgTable(
  'uitnodiging',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' }).references(() => wooneenheid.id),
    email: citext('email').notNull(),
    rol: rolType('rol').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    verlooptOp: timestamp('verloopt_op', { withTimezone: true }).notNull(),
    gebruiktOp: timestamp('gebruikt_op', { withTimezone: true }),
    verzondenOp: timestamp('verzonden_op', { withTimezone: true }),
    aantalVerzonden: smallint('aantal_verzonden').notNull().default(0),
    aangemaaktDoor: bigint('aangemaakt_door', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [
    index('ix_uitnodiging_vve').on(tabel.vveId),
    index('ix_uitnodiging_eenheid').on(tabel.wooneenheidId),
  ],
);

export type Uitnodiging = typeof uitnodiging.$inferSelect;
export type NieuweUitnodiging = typeof uitnodiging.$inferInsert;
