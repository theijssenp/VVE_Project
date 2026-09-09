import { describe, expect, it } from 'vitest';
import { Bedrag, grootsteRestVerdeler, type EenheidId } from '@vve/domein';

const verdeel = (centen: number, gewichten: Array<[EenheidId, number]>): Map<EenheidId, Bedrag> =>
  grootsteRestVerdeler.verdeel(Bedrag.vanCenten(centen), new Map(gewichten));

const som = (m: Map<EenheidId, Bedrag>): number =>
  [...m.values()].reduce((s, b) => s + b.centen, 0);

describe('Verdeler (spec §5.2, §7.3)', () => {
  it('de som is exact gelijk aan het te verdelen bedrag', () => {
    const uit = verdeel(1_000_000, [
      [1n, 125],
      [2n, 125],
      [3n, 250],
      [4n, 500],
    ]);
    expect(som(uit)).toBe(1_000_000);
    expect(uit.get(4n)?.centen).toBe(500_000);
  });

  it('bij gelijke rest gaat de cent naar het laagste eenheid-ID, niet naar de invoegvolgorde', () => {
    // Omgekeerd ingevoegd: als de verdeler op invoegvolgorde zou breken, kreeg 3n de cent.
    const uit = verdeel(1_000_000, [
      [3n, 1],
      [2n, 1],
      [1n, 1],
    ]);
    expect(uit.get(1n)?.centen).toBe(333_334);
    expect(uit.get(2n)?.centen).toBe(333_333);
    expect(uit.get(3n)?.centen).toBe(333_333);
    expect(som(uit)).toBe(1_000_000);
  });

  it('een uitgesloten eenheid (gewicht 0) krijgt niets', () => {
    const uit = verdeel(1000, [
      [1n, 0],
      [2n, 1],
      [3n, 1],
      [4n, 1],
    ]);
    expect(uit.get(1n)?.centen).toBe(0);
    expect(som(uit)).toBe(1000);
  });

  it('weigert een lege verzameling eenheden', () => {
    expect(() => verdeel(100, [])).toThrow(/geen eenheden/);
  });
});
