/**
 * Drizzle-schema — tabel `persoon` (spec §6.3).
 *
 * Moet EXACT overeenkomen met `migraties/0002_vve_persoon.sql` — de kolomnamen
 * (eerste factory-argument) en de datatypen. De migraties zijn leidend
 * (spec §6.1), dus:
 *   - `id` is `bigint GENERATED ALWAYS AS IDENTITY` (NIE char — de migratie maakt
 *    de primaire sleutel een bigint; een `char(2)` zou de FK-relaties later breken).
 *   - `email` is `citext` (case-insensitief) met een unieke constraint — de
 *    test "email is case-insensitief uniek" controleert dit.
 *   - `corrLand` is `char(2)` met default `'NL'`.
 *   - `herstelcodesHash` is `text[]` (array van argon2id-hashes).
 *   - `totpSecretVersleuteld` is `bytea` (versleuteld, spec §6.2/§6.3).
 *
 * De `persoon`-tabel heeft geen CHECK-constraints in de migratie, dus is de
 * extraConfig-functie bewust leeg (geen table-level constraints).
 */

import { bigint, boolean, char, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

import { bytea, citext } from './types.js';
import { communicatieWijze } from './enums.js';

export const persoon = pgTable(
  'persoon',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    email: citext('email').notNull().unique(),
    wachtwoordHash: text('wachtwoord_hash'),
    voorletters: text('voorletters'),
    voornaam: text('voornaam'),
    tussenvoegsel: text('tussenvoegsel'),
    achternaam: text('achternaam').notNull(),
    telefoon: text('telefoon'),
    corrStraat: text('corr_straat'),
    corrHuisnummer: text('corr_huisnummer'),
    corrPostcode: text('corr_postcode'),
    corrPlaats: text('corr_plaats'),
    corrLand: char('corr_land', { length: 2 }).notNull().default('NL'),
    communicatieWijze: communicatieWijze('communicatie_wijze').notNull().default('email'),
    isApplicatiebeheerder: boolean('is_applicatiebeheerder').notNull().default(false),
    wachtwoordWijzigenVerplicht: boolean('wachtwoord_wijzigen_verplicht').notNull().default(false),
    wachtwoordVerlooptOp: timestamp('wachtwoord_verloopt_op', { withTimezone: true }),
    mfaVerplicht: boolean('mfa_verplicht').notNull().default(false),
    totpSecretVersleuteld: bytea('totp_secret_versleuteld'),
    herstelcodesHash: text('herstelcodes_hash').array(),
    misluktePogingen: smallint('mislukte_pogingen').notNull().default(0),
    geblokkeerdTot: timestamp('geblokkeerd_tot', { withTimezone: true }),
    laatsteLoginOp: timestamp('laatste_login_op', { withTimezone: true }),
    actief: boolean('actief').notNull().default(true),
    aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
    gewijzigdOp: timestamp('gewijzigd_op', { withTimezone: true }),
  },
  () => [],
);

export type Persoon = typeof persoon.$inferSelect;
export type NieuwePersoon = typeof persoon.$inferInsert;
