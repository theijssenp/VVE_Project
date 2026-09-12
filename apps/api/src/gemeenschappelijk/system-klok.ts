/**
 * `SystemKlok` — de concrete tijdsimplementatie voor de API-laag (spec §7.3,
 * §7.6). Het pure `Klok`-interface staat in `packages/domein` (er is daar een
 * ESLint-verbod op `Date`, spec §7.2); hier — in de infrastructuurlaag van de
 * API — mag `Date` wél gebruikt worden. De auth-laag (`auth/token.ts`) neemt
 * een `Klok` aan in plaats van direct op `Date` te werken, zodat
 * vervaldatum- en hergebruiktests met een nepklok draaien zonder de echte tijd
 * te manipuleren.
 *
 * De vorm is bewust identiek aan `Klok`/`KalenderDag` uit `@vve/domein` — in
 * plaats van die te importeren. `apps/api` kent `@vve/domein` nog niet als
 * build-referentie (in tsconfig staat alleen `@vve/contract`), en een
 * `type`-import uit dat pakket breekt `tsc -b` (het pakket ligt buiten de
 * `rootDir` van `apps/api`). Een cross-pakket project reference is een
 * structurele wijziging die buiten dit deelstuk valt; zie `docs/besluiten.md`.
 * Zodra `@vve/domein` een referentie is, wordt deze definitie door de
 * domein-versie vervangen (dezelfde vorm, dus een drop-in).
 */

/** Kalenderdag zonder tijd of tijdzone (spec §5.8: `date`, geen tz-conversie). */
export interface KalenderDag {
  readonly jaar: number;
  readonly maand: number; // 1–12
  readonly dag: number; // 1–31
}

/** Geïnjecteerde tijdsabstractie (spec §7.3). Zelfde vorm als `@vve/domein` `Klok`. */
export interface Klok {
  /** Het actuele moment, UTC (spec §7.3). */
  nu(): Date;
  /** De kalenderdag in Europe/Amsterdam (spec §5.8, §7.3). */
  vandaag(): KalenderDag;
}

/**
 * Klok die de echte systeemtijd leest. `nu()` is UTC (een `Date` is per definitie
 * een moment in UTC). `vandaag()` geeft de kalenderdag in Europe/Amsterdam —
 * kalenderdata ondergaan nooit een tijdzoneconversie (spec §5.8).
 */
export class SystemKlok implements Klok {
  nu(): Date {
    return new Date();
  }

  vandaag(): KalenderDag {
    // De kalenderdeel (jaar/maand/dag) in Europe/Amsterdam, zonder de tijdsdeel
    // of een conversie op te sommen — een datum is een datum (spec §5.8).
    // formatToParts levert óók de letterlijke scheiders ('/') als onderdelen;
    // die worden expliciet weggefilterd — op Node 22 breekt de oude join anders
    // op "2026/-/09/-/12" (maand NaN, pg-fout 22007 op elke default-datum).
    const deeltjes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const onderdeel = (type: string): string => deeltjes.find((d) => d.type === type)?.value ?? '';
    const jaar = Number(onderdeel('year'));
    const maand = Number(onderdeel('month'));
    const dag = Number(onderdeel('day'));
    if (!Number.isInteger(jaar) || !Number.isInteger(maand) || !Number.isInteger(dag)) {
      throw new Error('SystemKlok.vandaag(): onleesbare kalenderdag van Intl.DateTimeFormat.');
    }
    return { jaar, maand, dag };
  }
}
