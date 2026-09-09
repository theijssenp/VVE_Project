/**
 * Drizzle-schema — hulptypes die niet standaard in de pg-core-coloms zijn
 * (blok F03, spec §6.3 / §6.2).
 *
 * `citext` en `bytea` zijn geen ingebouwde Drizzle-coloms in 0.45; ze worden
 * als `customType` gedefinieerd. De extensie `citext` (case-insensitieve
 * tekst) is aangemaakt in migratie `0001`; `bytea` is een standaard Postgres-type
 * voor versleutelde blob-kolommen (spec §6.2: nonce‖ciphertext‖tag).
 */

import { customType } from 'drizzle-orm/pg-core';

/**
 * Case-insensitieve tekstextensie. Gebruikt voor `persoon.email` en andere
 * unieke, case-insensitieve teksten. De extensie zelf is een migratie-zoog.
 */
export const citext = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'citext';
  },
});

/**
 * Binary blob. node-postgres levert `bytea` uit als `Buffer` en accepteert een
 * `Buffer`/`bytea`-string bij insert, dus geen mapping. Gebruikt voor de
 * versleutelde kolommen (spec §6.2) — hier in F03 alleen `totp_secret_versleuteld`.
 */
export const bytea = customType<{
  data: Buffer;
  driverData: Buffer;
}>({
  dataType() {
    return 'bytea';
  },
});
