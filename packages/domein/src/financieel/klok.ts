/**
 * `Klok` — geïnjecteerde tijdsabstractie (spec §7.3).
 *
 * PURE TypeScript: alleen het interface en het kalenderdag-type. De concrete
 * implementatie (`SystemKlok`, met `new Date()`) hoort in de infrastructuurlaag
 * van de API — hier staat de ESLint-verbodslijst op `Date` (spec §7.2/§7.3),
 * zodat vervaldatum-, aanmanings- en SEPA-termijntests betrouwbaar met een
 * nepklok kunnen draaien.
 *
 * `nu()` geeft het moment in UTC (aanroeper formatteert); `vandaag()` geeft de
 * kalenderdag in Europe/Amsterdam — kalenderdata ondergaan nooit een
 * tijdzoneconversie (spec §5.8).
 */

/** Kalenderdag zonder tijd of tijdzone (spec §5.8: `date`, geen tz-conversie). */
export interface KalenderDag {
  readonly jaar: number;
  readonly maand: number; // 1–12
  readonly dag: number; // 1–31
}

export interface Klok {
  /** Het actuele moment, UTC (spec §7.3). */
  nu(): Date;
  /** De kalenderdag in Europe/Amsterdam (spec §5.8, §7.3). */
  vandaag(): KalenderDag;
}