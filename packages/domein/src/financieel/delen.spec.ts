import { describe, expect, it } from 'vitest';
import { financieel } from '@vve/domein';

describe('domein/financieel (F01-smoke)', () => {
  it('somt hele- centen-bedragen exact op', () => {
    expect(financieel.somCenten([100, 250, 350])).toBe(700);
    expect(financieel.somCenten([])).toBe(0);
  });

  it('verdeelt op de grootste-restmethode met exacte som', () => {
    // 1000 centen over 3 aandeelen (1:1:1) -> 333, 333, 334; som is 1000.
    const delen = financieel.verdeelGrootsteRest(1000, [1, 1, 1]);
    expect(delen.reduce((s, v) => s + v, 0)).toBe(1000);
    expect(delen.sort()).toEqual([333, 333, 334]);
  });

  it('werpt op een negatief gewicht', () => {
    expect(() => financieel.verdeelGrootsteRest(100, [1, -1])).toThrow();
  });
});
