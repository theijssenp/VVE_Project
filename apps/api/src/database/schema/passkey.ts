/**
 * Drizzle-schema — tabel `passkey` (spec §6.3, blok F07).
 *
 * Moet exact overeenkomen met `migraties/0006_passkey.sql`. De kolomnamen
 * zijn Nederlands; WebAuthn-terminologie blijft Engels in de veldbetekenis
 * (credential_id, teller voor de WebAuthn counter).
 *
 * `bytea` is de customType uit `types.ts` (geen ingebouwde Drizzle-kolom in
 * 0.45); `persoon` wordt rechtstreeks geïmporteerd — de referentie-cyclus
 * naar dit schema staat niet open.
 */

import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { bytea } from './types.js';
import { persoon } from './persoon.js';

export const passkey = pgTable(
  'passkey',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    persoonId: bigint('persoon_id', { mode: 'bigint' })
      .notNull()
      .references(() => persoon.id, { onDelete: 'cascade' }),
    credentialId: bytea('credential_id').notNull().unique(),
    publiekeSleutel: bytea('publieke_sleutel').notNull(),
    teller: bigint('teller', { mode: 'bigint' }).notNull().default(0n),
    apparaatNaam: text('apparaat_naam'),
    laatstGebruiktOp: timestamp('laatst_gebruikt_op', { withTimezone: true }),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  },
  (tabel) => [index('ix_passkey_persoon').on(tabel.persoonId)],
);

export type Passkey = typeof passkey.$inferSelect;
export type NieuwePasskey = typeof passkey.$inferInsert;
