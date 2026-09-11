/**
 * Het standaard grootboekschema — G01 (spec §5.7, AC9.1).
 *
 * Letterlijk de rekeningenlijst uit de spec: 11 balansrekeningen, 21 lasten,
 * 6 baten. `4950` (dotatie reservefonds) en `8150` (voorschotbijdragen
 * reservefonds) zijn de twee helften waarmee de dotatie zichtbaar door de
 * exploitatie loopt en op de balans in `0600` landt (§5.7-tail).
 *
 * Gekopieerd bij het aanmaken van een VvE (vve-service, G01-drading) en daarna
 * per VvE vrij aanpasbaar.
 */

import type { NieuweGrootboekrekening } from '../database/schema/index.js';

/** Het standaard schema; `vveId` moet de aanroeper invullen. */
export function standaardGrootboekschema(
  vveId: bigint,
): Omit<NieuweGrootboekrekening, 'aangemaaktOp'>[] {
  const balans = (
    nummer: string,
    naam: string,
    categorie: 'activa' | 'passiva' | 'eigen_vermogen',
    isReservefonds = false,
  ) => ({
    vveId,
    nummer,
    naam,
    categorie,
    isReservefonds,
  });
  const kosten = (nummer: string, naam: string) => ({
    vveId,
    nummer,
    naam,
    categorie: 'lasten' as const,
    isReservefonds: false,
  });
  const baten = (nummer: string, naam: string, isReservefonds = false) => ({
    vveId,
    nummer,
    naam,
    categorie: 'baten' as const,
    isReservefonds,
  });

  return [
    // BALANS (§5.7)
    balans('0500', 'Algemene reserve / exploitatieoverschot', 'eigen_vermogen'),
    balans('0600', 'Reservefonds groot onderhoud', 'eigen_vermogen', true),
    balans('0700', 'Bestemmingsreserve (per project)', 'eigen_vermogen'),
    balans('1000', 'Kas', 'activa'),
    balans('1100', 'Bank exploitatierekening', 'activa'),
    balans('1150', 'Bank reserverekening', 'activa', true),
    balans('1300', 'Debiteuren (VvE-bijdragen)', 'activa'),
    balans('1350', 'Te ontvangen bedragen', 'activa'),
    balans('1600', 'Crediteuren', 'passiva'),
    balans('1700', 'Vooruitontvangen bijdragen', 'passiva'),
    balans('1750', 'Nog te betalen kosten', 'passiva'),

    // LASTEN (§5.7)
    kosten('4100', 'Onderhoud gebouw – dagelijks'),
    kosten('4110', 'Onderhoud installaties'),
    kosten('4120', 'Onderhoud lift'),
    kosten('4130', 'Onderhoud groen en terrein'),
    kosten('4150', 'Schoonmaak'),
    kosten('4200', 'Verzekering opstal'),
    kosten('4210', 'Verzekering aansprakelijkheid'),
    kosten('4220', 'Verzekering bestuurdersaansprakelijkheid'),
    kosten('4230', 'Rechtsbijstand'),
    kosten('4300', 'Elektra gemeenschappelijk'),
    kosten('4310', 'Water'),
    kosten('4320', 'Gas / warmte'),
    kosten('4400', 'Beheerkosten / administratie'),
    kosten('4410', 'Bankkosten'),
    kosten('4420', 'Kosten ALV en vergaderingen'),
    kosten('4430', 'Contributies en abonnementen'),
    kosten('4440', 'Advies- en juridische kosten'),
    kosten('4500', 'Belastingen en heffingen'),
    kosten('4900', 'Onvoorzien'),
    kosten('4950', 'Dotatie reservefonds'),

    // BATEN (§5.7)
    baten('8100', 'Voorschotbijdragen exploitatie'),
    baten('8150', 'Voorschotbijdragen reservefonds', true),
    baten('8200', 'Rente-inkomsten'),
    baten('8300', 'Doorbelaste kosten'),
    baten('8400', 'Boetes en incassokosten'),
    baten('8900', 'Overige baten'),
  ];
}
