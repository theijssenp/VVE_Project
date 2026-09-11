/**
 * Drizzle-schema — tabellen `mededeling` en `mail_sjabloon` (spec M13).
 *
 * Moet EXACT overeenkomen met migratie 0024. Alleen het DDL daar is leidend.
 * `mededeling_doelgroep` is nieuw in 0024 (niet in 0001 — gecheckt).
 */

import { bigint, boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { mededelingDoelgroep } from './enums.js';
import { persoon } from './persoon.js';
import { vve } from './vve.js';

export const mededeling = pgTable(
  'mededeling',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' })
      .notNull()
      .references(() => vve.id),
    titel: text('titel').notNull(),
    inhoud: text('inhoud').notNull(),
    doelgroep: mededelingDoelgroep('doelgroep').notNull(),
    gepubliceerdOp: timestamp('gepubliceerd_op', { withTimezone: true }).notNull().defaultNow(),
    doorPersoonId: bigint('door_persoon_id', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id),
    mailVerzonden: boolean('mail_verzonden').notNull().default(false),
  },
  (tabel) => [index('ix_mededeling_vve').on(tabel.vveId, tabel.gepubliceerdOp)],
);

export const mailSjabloon = pgTable('mail_sjabloon', {
  vveId: bigint('vve_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => vve.id),
  afzendernaam: text('afzendernaam').notNull(),
  ondertekening: text('ondertekening'),
  logoUrl: text('logo_url'),
  gewijzigdOp: timestamp('gewijzigd_op', { withTimezone: true }).notNull().defaultNow(),
});

export type Mededeling = typeof mededeling.$inferSelect;
export type NieuweMededeling = typeof mededeling.$inferInsert;
export type MailSjabloon = typeof mailSjabloon.$inferSelect;
export type NieuwMailSjabloon = typeof mailSjabloon.$inferInsert;
