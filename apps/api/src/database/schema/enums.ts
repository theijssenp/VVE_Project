/**
 * Drizzle-schema — de enums die de tabellen `vve` en `persoon` (spec §6.3)
 * aanroepen (blok F03).
 *
 * De enums zelf worden aangemaakt in migratie `0001_extensies_enums.sql`
 * (alle enums uit §6.1, nu in één keer zodat er later geen churn is). Dit
 * bestand declareert ze enkel als Drizzle-colomntype, zodat de queries
 * typeveilig zijn; het runtime-beheer (CREATE TYPE) is aan de migratie.
 *
 * Alleen de enums die vve/persoon daadwerkelijk gebruiken staan hier. De andere
 * ~30 enums uit §6.1 worden in latere blokken toegevoegd zodra hun tabellen
 * (eenheden, nota's, grootboek, …) er zijn. De migratie 0001 maakt ze alvast
 * aan — het Drizzle-schema groeit per blok, de migraties zijn leidend (spec §6.1).
 */

import { pgEnum } from 'drizzle-orm/pg-core';

export const vveStatus = pgEnum('vve_status', ['actief', 'gearchiveerd'] as const);

export const modelreglement = pgEnum('modelreglement', [
  'MR1973',
  'MR1983',
  'MR1992',
  'MR2006',
  'MR2017',
  'EIGEN',
] as const);

export const communicatieWijze = pgEnum('communicatie_wijze', ['email', 'post', 'beide'] as const);

// Blok F06b: roltypen voor `rol_toewijzing` (spec §6.1 / §6.3).
export const rolType = pgEnum('rol_type', [
  'applicatiebeheerder',
  'beheerder',
  'voorzitter',
  'penningmeester',
  'secretaris',
  'bestuurslid',
  'kascommissie',
  'eigenaar',
  'bewoner',
] as const);

// Blok V02: typen wooneenheden (spec §6.1 `eenheid_type`, tabel §6.4).
export const eenheidType = pgEnum('eenheid_type', [
  'woning',
  'parkeerplaats',
  'berging',
  'bedrijfsruimte',
  'gemeenschappelijk',
] as const);
