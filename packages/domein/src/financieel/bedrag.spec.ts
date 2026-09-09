import { describe, expect, it } from 'vitest';
import { financieel } from '@vve/domein';

const { Bedrag, BedragFout, formatteerEuro, parseInvoer } = financieel;

describe('domein/financieel — Bedrag (spec §7.3, §5.1)', () => {
  describe('constructie', () => {
    it('vanCenten accepteert alleen veilige gehele getallen', () => {
      expect(Bedrag.vanCenten(123456).formatteer()).toBe('€ 1.234,56');
      expect(Bedrag.vanCenten(0).formatteer()).toBe('€ 0,00');
      expect(() => Bedrag.vanCenten(12.5)).toThrow(BedragFout);
      expect(() => Bedrag.vanCenten(Number.NaN)).toThrow(BedragFout);
      expect(() => Bedrag.vanCenten(Number.POSITIVE_INFINITY)).toThrow(BedragFout);
    });

    it('vanInvoer accepteert "1.234,56", "1234.56" en "1234"', () => {
      expect(Bedrag.vanInvoer('1.234,56').formatteer()).toBe('€ 1.234,56');
      expect(Bedrag.vanInvoer('1234.56').formatteer()).toBe('€ 1.234,56');
      expect(Bedrag.vanInvoer('1234').formatteer()).toBe('€ 1.234,00');
      expect(Bedrag.vanInvoer('-12,05').formatteer()).toBe('-€ 12,05');
      expect(Bedrag.vanInvoer('0,05').formatteer()).toBe('€ 0,05');
    });

    it('vanInvoer weigert dubbelzinnige of te lange decimalen', () => {
      expect(() => Bedrag.vanInvoer('1.234.567')).toThrow(/Dubbelzinnig/);
      // "1,234": één komma = decimaalscheiding, maar "1.234" heeft drie decimalen — niet-herkenbaar.
      expect(() => Bedrag.vanInvoer('1,234')).toThrow(/Niet-herkenbare/);
      expect(() => Bedrag.vanInvoer('1,2345')).toThrow(/Niet-herkenbare/);
      expect(() => Bedrag.vanInvoer('')).toThrow(BedragFout);
      expect(() => Bedrag.vanInvoer('abc')).toThrow(BedragFout);
    });
  });

  describe('rekenkunde', () => {
    it('plus en min zijn exact en houden de veilige grens bewaakt', () => {
      expect(Bedrag.vanCenten(100).plus(Bedrag.vanCenten(250)).formatteer()).toBe('€ 3,50');
      expect(Bedrag.vanCenten(100).min(Bedrag.vanCenten(250)).isNegatief()).toBe(true);
      expect(() =>
        Bedrag.vanCenten(Number.MAX_SAFE_INTEGER - 10).plus(Bedrag.vanCenten(11)),
      ).toThrow(/veilige integerruimte/);
    });

    it('maal accepteert uitsluitend gehele factoren', () => {
      expect(Bedrag.vanCenten(333).maal(3).formatteer()).toBe('€ 9,99');
      expect(() => Bedrag.vanCenten(100).maal(1.5)).toThrow(/geheel/);
      expect(() => Bedrag.vanCenten(Number.MAX_SAFE_INTEGER - 1).maal(2)).toThrow(
        /veilige integerruimte/,
      );
    });
  });

  describe('presentatie (§5.1)', () => {
    it('formateert nl-NL: duizendtallen met punt, decimaal met komma', () => {
      expect(formatteerEuro(123456789)).toBe('€ 1.234.567,89');
      expect(formatteerEuro(5)).toBe('€ 0,05');
      expect(formatteerEuro(-99)).toBe('-€ 0,99');
      expect(formatteerEuro(-1_234_567)).toBe('-€ 12.345,67');
    });
  });
});

describe('domein/financieel — parseInvoer (losse functie)', () => {
  it('rond-trip via centen', () => {
    expect(parseInvoer('12.345,67')).toBe(1_234_567);
    expect(parseInvoer('12345.67')).toBe(1_234_567);
    expect(parseInvoer('67')).toBe(6_700);
  });
});
