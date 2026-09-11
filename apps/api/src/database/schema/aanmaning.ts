/**
 * Drizzle-schema — tabellen `aanmaning` en `aanmaning_instelling` (spec §5.5).
 *
 * Moet EXACT overeenkomen met migratie 0022. Alleen het DDL daar is leidend.
 * Drie stappen per nota (UNIQUE nota+stap), elke stap een document; de
 * termijnen en de rentegrondslag staan per VvE in de instellingen.
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { aanmaningStap, renteGrondslag } from './enums.js';
import { nota } from './nota.js';
import { vve } from './vve.js';

export const aanmaningInstelling = pgTable('aanmaning_instelling', {
  vveId: bigint('vve_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => vve.id),
  herinneringDagen: integer('herinnering_dagen').notNull().default(7),
  aanmaningDagen: integer('aanmaning_dagen').notNull().default(21),
  ingebrekestellingDagen: integer('ingebrekestelling_dagen').notNull().default(45),
  renteGrondslag: renteGrondslag('rente_grondslag').notNull().default('wettelijk'),
  rentePercentage: numeric('rente_percentage', { precision: 5, scale: 2 }).notNull().default('0'),
  aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
});

export const aanmaning = pgTable(
  'aanmaning',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    notaId: bigint('nota_id', { mode: 'bigint' })
      .notNull()
      .references(() => nota.id),
    stap: aanmaningStap('stap').notNull(),
    verstuurdOp: date('verstuurd_op').notNull(),
    tekst: text('tekst').notNull(),
    isVeertiendagen: boolean('is_veertiendagen').notNull().default(false),
    kostenCent: bigint('kosten_cent', { mode: 'number' }).notNull().default(0),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_aanmaning_nota').on(tabel.notaId, tabel.stap)],
);

export type Aanmaning = typeof aanmaning.$inferSelect;
export type NieuweAanmaning = typeof aanmaning.$inferInsert;
export type AanmaningInstelling = typeof aanmaningInstelling.$inferSelect;
export type NieuweAanmaningInstelling = typeof aanmaningInstelling.$inferInsert;
