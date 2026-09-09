import { describe, expect, it } from 'vitest';
import type { KalenderDag, Klok } from '@vve/domein';

/**
 * Nepklok met vast moment: 2026-03-29T23:30:00Z. In Europe/Amsterdam is dat
 * 30 maart 2026, 01:30 — een kalenderdag die van de UTC-datum afwijkt. Precies
 * daarom bestaat de split tussen `nu()` en `vandaag()` (spec §5.8/§7.3).
 */
class VasteKlok implements Klok {
  private readonly moment = new Date('2026-03-29T23:30:00Z');

  nu(): Date {
    return this.moment;
  }

  vandaag(): KalenderDag {
    // Europe/Amsterdam eind maart 2026: CEST (UTC+2, zomertijd begon 29-03).
    // De productie-implementatie in de infrastructuurlaag gebruikt Intl; de
    // testklok hardcoded het verwachte resultaat — het interface is het contract.
    return { jaar: 2026, maand: 3, dag: 30 };
  }
}

describe('domein/financieel — Klok (spec §7.3)', () => {
  it('nu() geeft het vastgezette moment terug', () => {
    const klok = new VasteKlok();
    expect(klok.nu().toISOString()).toBe('2026-03-29T23:30:00.000Z');
  });

  it('vandaag() geeft de Amsterdamse kalenderdag, onafhankelijk van UTC-datum', () => {
    const klok = new VasteKlok();
    const dag: KalenderDag = klok.vandaag();
    expect(dag).toEqual({ jaar: 2026, maand: 3, dag: 30 });
  });
});
