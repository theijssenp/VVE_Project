/**
 * Matchingvoorstellen en opslaanbare boekingsregels — blok B05 (AC7.4–7.5).
 */
import {
  bigint,
  boolean,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { bankmutatie } from './bank.js';
import { grootboekrekening } from './grootboekrekening.js';
import { nota } from './nota.js';
import { vve } from './vve.js';
import { wooneenheid } from './wooneenheid.js';

export const bankMatchSoort = pgEnum('bank_match_soort', [
  'betalingskenmerk',
  'end_to_end',
  'iban_bedrag',
  'iban_fifo',
  'leverancier',
  'boekingsregel',
  'intern',
] as const);

export const bankVoorstel = pgTable('bank_voorstel', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  vveId: bigint('vve_id', { mode: 'bigint' })
    .notNull()
    .references(() => vve.id, { onDelete: 'cascade' }),
  bankmutatieId: bigint('bankmutatie_id', { mode: 'bigint' })
    .notNull()
    .references(() => bankmutatie.id, { onDelete: 'cascade' }),
  soort: bankMatchSoort('soort').notNull(),
  notaId: bigint('nota_id', { mode: 'bigint' }).references(() => nota.id, { onDelete: 'cascade' }),
  grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' }).references(
    () => grootboekrekening.id,
  ),
  wooneenheidId: bigint('wooneenheid_id', { mode: 'bigint' }).references(() => wooneenheid.id),
  bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
  /** 100 = exact; lager betekent voorstel, en de motor boekt daar niet op. */
  zekerheid: smallint('zekerheid').notNull(),
  toelichting: text('toelichting').notNull(),
  aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
});

export const bankBoekingsregel = pgTable(
  'bank_boekingsregel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id, { onDelete: 'cascade' }),
    bevat: text('bevat').notNull(),
    grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' })
      .notNull()
      .references(() => grootboekrekening.id),
    omschrijving: text('omschrijving'),
    aantalToepassingen: integer('aantal_toepassingen').notNull().default(0),
    actief: boolean('actief').notNull().default(true),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bank_boekingsregel_vve_bevat').on(t.vveId, t.bevat)],
);
