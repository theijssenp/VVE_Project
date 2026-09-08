import { describe, expect, it } from 'vitest';
import { financieel } from '@vve/domein';

const { somCenten, verdeelGrootsteRest } = financieel;

describe('domein/financieel — somCenten', () => {
  it('somt hele centen exact op', () => {
    expect(somCenten([100, 250, 350])).toBe(700);
    expect(somCenten([])).toBe(0);
  });

  it('weigert bedragen die geen hele centen zijn', () => {
    expect(() => somCenten([100, 12.5])).toThrow(/hele centen/);
  });

  it('weigert een som buiten de veilige integerruimte', () => {
    expect(() => somCenten([Number.MAX_SAFE_INTEGER, 1])).toThrow(/veilige integerruimte/);
  });
});

describe('domein/financieel — verdeelGrootsteRest (spec §5.2)', () => {
  // De volgorde is onderdeel van de regel, niet toeval: bij gelijke fractie krijgt de
  // laagste index de restcent. Daarom exacte arrays vergelijken en niet sorteren.
  it('§11 test 1 — € 10.000,00 over 3 gelijke delen', () => {
    expect(verdeelGrootsteRest(1_000_000, [1, 1, 1])).toEqual([333_334, 333_333, 333_333]);
  });

  it('§11 test 2 — verdeling over breukdelen 125/125/250/500', () => {
    expect(verdeelGrootsteRest(1_000_000, [125, 125, 250, 500])).toEqual([
      125_000, 125_000, 250_000, 500_000,
    ]);
  });

  it('§11 test 3 — een uitgesloten eenheid (gewicht 0) krijgt niets', () => {
    expect(verdeelGrootsteRest(1000, [0, 1, 1, 1])).toEqual([0, 334, 333, 333]);
  });

  it('§11 test 4 — jaarbedrag over 12 perioden telt exact op', () => {
    const perioden = verdeelGrootsteRest(10_000, Array<number>(12).fill(1));
    expect(perioden).toHaveLength(12);
    expect(somCenten(perioden)).toBe(10_000);
    expect(perioden.slice(0, 4)).toEqual([834, 834, 834, 834]);
  });

  it('werkt met fractionele gewichten (m²-sleutel, numeric(14,4))', () => {
    const delen = verdeelGrootsteRest(123_457, [78.45, 45.1234, 110.0]);
    expect(somCenten(delen)).toBe(123_457);
  });

  it('is deterministisch: dezelfde invoer geeft altijd dezelfde uitvoer', () => {
    const eerste = verdeelGrootsteRest(999_999, [7, 7, 7, 7, 7, 7, 7]);
    const tweede = verdeelGrootsteRest(999_999, [7, 7, 7, 7, 7, 7, 7]);
    expect(eerste).toEqual(tweede);
    expect(somCenten(eerste)).toBe(999_999);
  });

  it('werpt bij een negatief gewicht, een lege reeks en een nulsom', () => {
    expect(() => verdeelGrootsteRest(100, [1, -1])).toThrow(/niet-negatief/);
    expect(() => verdeelGrootsteRest(100, [])).toThrow(/niet leeg/);
    expect(() => verdeelGrootsteRest(100, [0, 0])).toThrow(/nul/);
  });

  it('werpt als totaal × gewicht buiten de veilige integerruimte valt', () => {
    expect(() => verdeelGrootsteRest(1_000_000_000, [Number.MAX_SAFE_INTEGER, 1])).toThrow(
      /veilige integerruimte/,
    );
  });
});
