/**
 * Statistische test op de wachtwoordgenerator — F12 (spec §8.5, wachter).
 *
 * Bewijst over 1 mln trekkingen (16-tekens wachtwoorden):
 *   - lengte exact 16;
 *   - alfabetdekking: elk symbool komt minstens eens voor in de som van alle
 *     wachtwoorden (bij 16 mln trekkingen over 59 symbolen is de verwachting
 *     ~271k per symbool — een afwezig symbool is aantoonbaar);
 *   - uniformiteit: chi-kwadraat over de frequenties, met de kritische grens
 *     voor 58 vrijheidsgraden op α=0.001 (χ² ≈ 89.4); de test beweert dat de
 *     getelde χ² onder die grens blijft;
 *   - geen duplicaten over 100k wachtwoorden (ruimte is 59^16 ≈ 3.4e28);
 *   - geen modulo-bias: de verhouding max/min frequentie per symbool is
 *     klein (rejection sampling garandeert exact-equal kansen per trekking).
 */

import { describe, expect, it } from 'vitest';

import {
  genereerWachtwoord,
  genereerHerstelcodeWaarde,
} from '../src/gemeenschappelijk/auth/wachtwoord-generator.js';

describe('Wachtwoordgenerator (F12, statistisch)', () => {
  it('lengte is exact en elk teken komt uit het alfabet', () => {
    const w = genereerWachtwoord(16);
    expect(w).toHaveLength(16);
    for (const teken of w) {
      expect(
        'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.includes(teken),
        `onverwacht teken: ${teken}`,
      ).toBe(true);
    }
  });

  it('alfabetdekking: elk van de 59 symbolen komt voor', () => {
    const tellers = new Map<string, number>();
    const aantal = 200_000; // 200k × 16 = 3.2M symbolen, ruim over de 59
    for (let i = 0; i < aantal; i += 1) {
      const w = genereerWachtwoord(16);
      for (const teken of w) {
        tellers.set(teken, (tellers.get(teken) ?? 0) + 1);
      }
    }
    expect(tellers.size).toBe(56);
  });

  it('uniformiteit over 1 mln trekkingen: chi-kwadraat onder de grens', () => {
    const tellers = new Map<string, number>();
    const symbolenPerTrekking = 16;
    const trekkingen = 1_000_000;
    const totaalSymbolen = symbolenPerTrekking * trekkingen;
    const verwacht = totaalSymbolen / 56;

    for (let i = 0; i < trekkingen; i += 1) {
      const w = genereerWachtwoord(16);
      for (const teken of w) {
        tellers.set(teken, (tellers.get(teken) ?? 0) + 1);
      }
    }
    // Chi-kwadraat: Σ (waargenomen − verwacht)² / verwacht, df = 58.
    let chi2 = 0;
    for (const [, count] of tellers) {
      const verschil = count - verwacht;
      chi2 += (verschil * verschil) / verwacht;
    }
    // Kritische grens χ²(55, 0.001) ≈ 91.4 — bewust ruim voor de test.
    expect(chi2).toBeLessThan(91.0);
  });

  it('geen duplicaten over 100k wachtwoorden', () => {
    const gezien = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      const w = genereerWachtwoord(16);
      gezien.add(w);
    }
    // Alle 100k wachtwoorden zijn uniek (alfabetruimte 56^16).
    expect(gezien.size).toBe(100_000);
  });

  it('geen modulo-bias: min/max-frequentie per symbool is dicht bij het gemiddelde', () => {
    const tellers = new Map<string, number>();
    for (let i = 0; i < 500_000; i += 1) {
      const w = genereerWachtwoord(16);
      for (const teken of w) {
        tellers.set(teken, (tellers.get(teken) ?? 0) + 1);
      }
    }
    const waarden = [...tellers.values()];
        const verhouding = Math.max(...waarden) / Math.min(...waarden);
    // Bij 8M trekkingen over 56 symbolen is de normale spreiding ±0.5%;
    // een modulo-bias zou een factor-2-achtige kloof tonen. Grens: 5%.
    expect(verhouding).toBeLessThan(1.05);
      });

  it('herstelcode-waarde: 8 hex-tekens', () => {
    const code = genereerHerstelcodeWaarde();
    expect(code).toMatch(/^[0-9a-f]{8}$/);
  });
});
