/**
 * Drizzle-schema — tabellen `boeking` en `boekingsregel` (spec §6.7).
 *
 * Moet EXACT overeenkomen met migratie 0014. Alleen het DDL daar is leidend.
 *
 * Append-only (§7.4): de service schrijft, niemand muteert. De balanseis
 * (som(debet) = som(credit) per boeking) bewaakt de deferred constraint
 * trigger uit de migratie; de boekingsservice controleert hem óók zelf
 * vóór het schrijven (§7.4: "beide moeten bestaan").
 */

import { bigint, boolean, check, date, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { boekingBron } from './enums.js';
import { grootboekrekening } from './grootboekrekening.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';
import { boekjaar } from './boekjaar.js';

export const boeking = pgTable(
  'boeking',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    boekjaarId: bigint('boekjaar_id', { mode: 'bigint' })
      .notNull()
      .references(() => boekjaar.id),
    nummer: text('nummer').notNull(),
    datum: date('datum').notNull(),
    omschrijving: text('omschrijving').notNull(),
    bron: boekingBron('bron').notNull(),
    bronId: bigint('bron_id', { mode: 'bigint' }),
    vergrendeld: boolean('vergrendeld').notNull().default(false),
    aangemaaktDoor: bigint('aangemaakt_door', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_boeking_datum').on(tabel.vveId, tabel.datum)],
);

export const boekingsregel = pgTable(
  'boekingsregel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    boekingId: bigint('boeking_id', { mode: 'bigint' })
      .notNull()
      .references(() => boeking.id, { onDelete: 'restrict' }),
    grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' })
      .notNull()
      .references(() => grootboekrekening.id),
    wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' }).references(() => wooneenheid.id),
    omschrijving: text('omschrijving'),
    debetCent: bigint('debet_cent', { mode: 'number' }).notNull().default(0),
    creditCent: bigint('credit_cent', { mode: 'number' }).notNull().default(0),
  },
  (tabel) => [
    check('boekingsregel_debet_niet_negatief', sql`${tabel.debetCent} >= 0`),
    check('boekingsregel_credit_niet_negatief', sql`${tabel.creditCent} >= 0`),
    check(
      'boekingsregel_precies_een_zijde',
      sql`(${tabel.debetCent} = 0) <> (${tabel.creditCent} = 0)`,
    ),
    index('ix_regel_grootboek').on(tabel.grootboekrekeningId, tabel.boekingId),
    index('ix_regel_eenheid').on(tabel.wooneenheidId),
  ],
);

export type Boeking = typeof boeking.$inferSelect;
export type NieuweBoeking = typeof boeking.$inferInsert;
export type Boekingsregel = typeof boekingsregel.$inferSelect;
export type NieuweBoekingsregel = typeof boekingsregel.$inferInsert;
