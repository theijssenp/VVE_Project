/**
 * Drizzle-schema — tabellen `mail_wachtrij` en `instelling` (spec §6.8, F10).
 *
 * `mail_wachtrij`: alle uitgaande mail met statusflow wachtend → bezig →
 * verzonden | mislukt (§7.7). `instelling`: systeeminstellingen als JSONB.
 * De enums (`mail_status`) bestaan sinds migratie 0001.
 */

import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { citext } from './types.js';

export const mailWachtrij = pgTable(
  'mail_wachtrij',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' }),
    ontvangerEmail: citext('ontvanger_email').notNull(),
    antwoordAdres: text('antwoord_adres'),
    onderwerp: text('onderwerp').notNull(),
    tekst: text('tekst').notNull(),
    isHtml: boolean('is_html').notNull().default(false),
    bijlagePad: text('bijlage_pad'),
    categorie: text('categorie').notNull().default('app'),
    status: text('status').notNull().default('wachtend'),
    aantalPogingen: smallint('aantal_pogingen').notNull().default(0),
    laatstePogingOp: timestamp('laatste_poging_op', { withTimezone: true }),
    foutmelding: text('foutmelding'),
    afleverVoor: timestamp('aflever_vóór', { withTimezone: true }),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_mail_status').on(tabel.status, tabel.afleverVoor)],
);

export type MailWachtrij = typeof mailWachtrij.$inferSelect;
export type NieuweMailWachtrij = typeof mailWachtrij.$inferInsert;

export const instelling = pgTable('instelling', {
  sleutel: text('sleutel').primaryKey(),
  waarde: jsonb('waarde').notNull(),
  gewijzigdOp: timestamp('gewijzigd_op', { withTimezone: true }).notNull().defaultNow(),
});

export type Instelling = typeof instelling.$inferSelect;
