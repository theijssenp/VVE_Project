/**
 * Drizzle-schema — tabellen `begroting` en `begrotingsregel` (spec §6.5).
 *
 * Moet EXACT overeenkomen met migratie 0016. Alleen het DDL daar is leidend.
 * `bedragCent` is bigint in centen met `mode: 'number'` (veilig binnen de
 * 2^53-grens, het domein van F05). De `besluit_id`-FK uit de spec komt met
 * het besluitenregister (A03); de kolom bestaat al in de migratie.
 */

import { bigint, boolean, index, pgTable, smallint, text } from 'drizzle-orm/pg-core';

import { begrotingStatus } from './enums.js';
import { grootboekrekening } from './grootboekrekening.js';
import { verdeelsleutel } from './verdeelsleutel.js';
import { vve } from './vve.js';
import { boekjaar } from './boekjaar.js';

export const begroting = pgTable('begroting', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  vveId: bigint('vve_id', { mode: 'bigint' })
    .notNull()
    .references(() => vve.id),
  boekjaarId: bigint('boekjaar_id', { mode: 'bigint' })
    .notNull()
    .references(() => boekjaar.id),
  status: begrotingStatus('status').notNull().default('concept'),
  vastgesteldOp: text('vastgesteld_op'),
  besluitId: bigint('besluit_id', { mode: 'bigint' }),
});

export const begrotingsregel = pgTable(
  'begrotingsregel',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    begrotingId: bigint('begroting_id', { mode: 'bigint' })
      .notNull()
      .references(() => begroting.id, { onDelete: 'cascade' }),
    grootboekrekeningId: bigint('grootboekrekening_id', { mode: 'bigint' })
      .notNull()
      .references(() => grootboekrekening.id),
    omschrijving: text('omschrijving').notNull(),
    bedragCent: bigint('bedrag_cent', { mode: 'number' }).notNull(),
    verdeelsleutelId: bigint('verdeelsleutel_id', { mode: 'bigint' })
      .notNull()
      .references(() => verdeelsleutel.id),
    isReservefonds: boolean('is_reservefonds').notNull().default(false),
    volgorde: smallint('volgorde').notNull().default(0),
  },
  (tabel) => [index('ix_begrotingsregel_begroting').on(tabel.begrotingId)],
);

export type Begroting = typeof begroting.$inferSelect;
export type NieuweBegroting = typeof begroting.$inferInsert;
export type Begrotingsregel = typeof begrotingsregel.$inferSelect;
export type NieuweBegrotingsregel = typeof begrotingsregel.$inferInsert;
