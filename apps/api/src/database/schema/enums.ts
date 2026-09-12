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

// Blok G01: categorieën van het grootboek (spec §6.1 `grootboek_categorie`).
export const grootboekCategorie = pgEnum('grootboek_categorie', [
  'activa',
  'passiva',
  'eigen_vermogen',
  'lasten',
  'baten',
] as const);

// Blok G02: status van het boekjaar (spec §6.1 `boekjaar_status`).
export const boekjaarStatus = pgEnum('boekjaar_status', ['concept', 'open', 'afgesloten'] as const);

// Blok G02: bron van een boeking (spec §6.1 `boeking_bron`).
export const boekingBron = pgEnum('boeking_bron', [
  'nota',
  'betaling',
  'bank',
  'incasso',
  'memoriaal',
  'openingsbalans',
  'jaarafsluiting',
] as const);

// Blok G03: typen verdeelsleutels (spec §6.1 `verdeelsleutel_type`, M4).
export const verdeelsleutelType = pgEnum('verdeelsleutel_type', [
  'breukdeel',
  'vierkante_meters',
  'gelijke_delen',
  'stemmen',
  'handmatig',
] as const);

// Blok G04: status van begroting en bijdrageschema (§6.1 `begroting_status`).
export const begrotingStatus = pgEnum('begroting_status', [
  'concept',
  'voorgesteld_alv',
  'vastgesteld',
  'gesloten',
] as const);

// Blok B01: SEPA-machtiging (§6.1 `machtiging_type`, `machtiging_status`).
export const machtigingType = pgEnum('machtiging_type', ['CORE', 'B2B'] as const);
export const machtigingStatus = pgEnum('machtiging_status', [
  'actief',
  'geblokkeerd',
  'ingetrokken',
  'verlopen',
] as const);

// Blok G05: bijdragemethoden en periodiciteit (§6.1, M5).
export const bijdrageMethode = pgEnum('bijdrage_methode', [
  'uit_begroting',
  'vast_bedrag',
  'vierkante_meters',
] as const);
export const periodiciteit = pgEnum('periodiciteit', ['maand', 'kwartaal', 'jaar'] as const);
export const bijdrageBron = pgEnum('bijdrage_bron', ['berekend', 'handmatig'] as const);

// Blok G08: betalingsbronnen (§6.1 `betaling_bron`).
export const betalingBron = pgEnum('betaling_bron', [
  'bank',
  'kas',
  'handmatig',
  'incasso',
  'verrekening',
] as const);
// Blok G11: aanmaningstraject (§6.1 `aanmaning_stap`, `rente_grondslag`).
export const aanmaningStap = pgEnum('aanmaning_stap', [
  'herinnering',
  'aanmaning',
  'ingebrekestelling',
] as const);
export const renteGrondslag = pgEnum('rente_grondslag', [
  'wettelijk',
  'reglementair',
  'geen',
] as const);

// Blok A05: `verplichting_soort` is al in 0001 (§6.1-hoofdlijst, volledige
// soortenlijst); alleen de Drizzle-spiegel hier.
export const verplichtingSoort = pgEnum('verplichting_soort', [
  'liftkeuring',
  'brandmeldinstallatie',
  'legionella',
  'nen3140',
  'opstalverzekering',
  'aansprakelijkheid',
  'bestuurdersaansprakelijkheid',
  'rechtsbijstand',
  'energielabel',
  'overig',
] as const);

// Blok A06: mededelingen (M13 `mededeling_doelgroep`, nieuw in 0024).
export const mededelingDoelgroep = pgEnum('mededeling_doelgroep', [
  'alle_leden',
  'eigenaren',
  'bewoners',
] as const);

// Blok G06: nota's (§6.1 `nota_type`, `nota_status`, `betaalwijze`).
export const notaType = pgEnum('nota_type', [
  'periodieke_bijdrage',
  'afrekening',
  'eenmalige_heffing',
  'boete',
  'rente',
  'incassokosten',
  'credit',
] as const);
export const notaStatus = pgEnum('nota_status', [
  'concept',
  'open',
  'deels_betaald',
  'betaald',
  'gecrediteerd',
  'oninbaar',
] as const);
export const betaalwijze = pgEnum('betaalwijze', ['incasso', 'overboeking'] as const);

// Blok V05: documenten (M3; enum `zichtbaarheid` uit 0001 — spiegel).
export const zichtbaarheid = pgEnum('zichtbaarheid', [
  'alle_leden',
  'bewoners',
  'bestuur',
  'alleen_beheerder',
] as const);
