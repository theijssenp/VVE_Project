/**
 * Drizzle-schema — tabel `apparaat_sessie` (spec §6.3).
 *
 * Moet EXACT overeenkomen met migratie 0005. Eén rij per apparaat met
 * roterende refresh tokens.
 *
 * - `refresh_token_hash` is `char(64)` met een SHA-256 hex-value; het ruwe
 *   token verlaat de database nooit (spec §8.2).
 * - `familie_id` is de UUID van de rotatielijn: wanneer een reeds
 *   ingewisseld refresh token opnieuw wordt voorgesteld (herbruikdetectie,
 *   spec §7.6, §11 test #35) wordt de gehele familie ingetrokken.
 * - `ingetrokken_op` en `intrekking_reden` zijn NULL terwijl de sessie
 *   actief is en worden gevuld wanneer de sessie wordt ingetrokken.
 *
 * Deze tabel is géén tenant-tabel (geen `vve_id`); per §6.9 is er dus
 * géén RLS-policy op `app.vve_id` nodig. De default privileges van
 * migratie 0004 geven `vve_app` al SELECT/INSERT/UPDATE/DELETE.
 */

import { bigint, char, inet, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { persoon } from './persoon.js';

export const apparaatSessie = pgTable('apparaat_sessie', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  persoonId: bigint('persoon_id', { mode: 'bigint' })
    .notNull()
    .references(() => persoon.id, { onDelete: 'cascade' }),
  familieId: uuid('familie_id').notNull().defaultRandom(),
  refreshTokenHash: char('refresh_token_hash', { length: 64 }).notNull().unique(),
  vorigeTokenHash: char('vorige_token_hash', { length: 64 }),
  platform: text('platform'),
  apparaatNaam: text('apparaat_naam'),
  ipLaatste: inet('ip_laatste'),
  userAgent: text('user_agent'),
  verlooptOp: timestamp('verloopt_op', { withTimezone: true }).notNull(),
  ingetrokkenOp: timestamp('ingetrokken_op', { withTimezone: true }),
  intrekkingReden: text('intrekking_reden'),
  laatsteGebruiktOp: timestamp('laatst_gebruikt_op', { withTimezone: true }),
  aangemaaktOp: timestamp('aangemaakt_op', { withTimezone: true }).notNull().defaultNow(),
  /**
   * De actieve VvE van deze sessie (migratie 0011). Gezet via
   * `POST /auth/actieve-vve`, nadat de service een lopende `rol_toewijzing`
   * in die VvE heeft gecontroleerd; geclaimd in het access-token en geërfd bij
   * elke rotatie (spec §7.5 stap 2: de tenant komt uit het token).
   */
  actieveVveId: bigint('actieve_vve_id', { mode: 'bigint' }),
});

export type ApparaatSessie = typeof apparaatSessie.$inferSelect;
export type NieuweApparaatSessie = typeof apparaatSessie.$inferInsert;
