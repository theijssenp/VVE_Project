/**
 * `Verdeler` — verdeling van een bedrag over eenheden (spec §5.2, §7.3).
 *
 * Dun typeveilig omhulsel om `verdeelGrootsteRest`: die functie is bewezen
 * (§11 tests 1–4, plus een differentiële toets tegen een exacte BigInt-referentie
 * over 250.000 gevallen) en verandert hier niet. Wat dit toevoegt is dat aanroepers
 * met `Bedrag` en eenheid-ID's werken in plaats van met kale getallen, zodat de
 * verdeelsleutels (G03) en het bijdrageschema (G05) niet elk hun eigen conversie
 * verzinnen.
 */

import { Bedrag } from './bedrag.js';
import { verdeelGrootsteRest } from './delen.js';

/** Sleutel van een wooneenheid; `bigint` volgt de identiteitskolom (§6.4). */
export type EenheidId = bigint;

export interface Verdeler {
  /**
   * Verdeelt `totaal` over `gewichten` volgens de grootste-restmethode.
   * Garantie: de som van de uitkomsten is exact gelijk aan `totaal`.
   */
  verdeel(totaal: Bedrag, gewichten: ReadonlyMap<EenheidId, number>): Map<EenheidId, Bedrag>;
}

/**
 * De verdeler uit §5.2. Restcenten gaan naar de grootste fractionele rest; bij
 * gelijke rest naar het **laagste eenheid-ID** — niet naar de invoegvolgorde van
 * de Map. Dat is wat de uitkomst reproduceerbaar maakt: dezelfde begroting levert
 * op twee momenten dezelfde nota op, ongeacht in welke volgorde de eenheden
 * uit de database kwamen.
 */
export const grootsteRestVerdeler: Verdeler = {
  verdeel(totaal: Bedrag, gewichten: ReadonlyMap<EenheidId, number>): Map<EenheidId, Bedrag> {
    if (gewichten.size === 0) {
      throw new Error('Verdeler: geen eenheden om over te verdelen');
    }
    const opId = [...gewichten.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const delen = verdeelGrootsteRest(
      totaal.centen,
      opId.map(([, gewicht]) => gewicht),
    );

    const uitkomst = new Map<EenheidId, Bedrag>();
    opId.forEach(([id], i) => {
      uitkomst.set(id, Bedrag.vanCenten(delen[i] ?? 0));
    });
    return uitkomst;
  },
};
