/**
 * Jaarrekening — blok B08 (spec M9 · AC9.4).
 *
 * Balans en staat van baten en lasten, elk met twee vergelijkende kolommen:
 * het vorige boekjaar en de vastgestelde begroting. Die kolommen zijn de reden
 * dat dit een eigen service is en geen opmaakje op B07: de cijfers komen uit
 * drie bronnen (dit jaar, vorig jaar, begroting) en moeten per rekening naast
 * elkaar komen te staan, ook als een rekening in één van de drie ontbreekt.
 *
 * **Tekenafspraak.** In de balans staan activa aan de debetkant en passiva plus
 * eigen vermogen aan de creditkant; een positief bedrag betekent hier dus
 * "saldo aan de eigen kant van de rekening". Bij de staat van baten en lasten
 * staan lasten debet en baten credit. Zo staan er nergens negatieve bedragen in
 * beeld die eigenlijk "andersom" betekenen — dat is voor een vrijwilliger de
 * grootste bron van verwarring in een jaarrekening.
 *
 * **Het resultaat wordt afgeleid, niet opgezocht.** Baten minus lasten. Het is
 * bewust *niet* het saldo van een resultaatrekening: dat saldo bestaat pas na
 * het afsluiten (AC9.3), en de jaarrekening moet ook vóór het afsluiten
 * kloppen — juist dán wordt hij gelezen, namelijk in de ALV.
 *
 * **Balanscontrole.** `inBalans` toetst dat activa gelijk zijn aan passiva plus
 * eigen vermogen plus het resultaat van het lopende jaar. Vóór het afsluiten is
 * het resultaat nog niet naar het eigen vermogen geboekt; zonder die term zou
 * de controle dus altijd falen op precies het moment dat hij nodig is.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { begroting, begrotingsregel } from '../database/schema/begroting.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { vve } from '../database/schema/vve.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { NietGevondenFout } from './boekhouding.js';
import { maakBalansService, type BalansRegel } from './balans-service.js';

export interface JaarrekeningRegel {
  readonly nummer: string;
  readonly naam: string;
  readonly isReservefonds: boolean;
  /** Bedrag in centen, positief aan de eigen kant van de rekening. */
  readonly bedragCent: number;
  /** Zelfde rekening in het vorige boekjaar; `null` als dat jaar ontbreekt. */
  readonly vorigJaarCent: number | null;
  /** Begroot bedrag voor dit jaar; `null` als er niets voor begroot is. */
  readonly begrootCent: number | null;
}

export interface JaarrekeningGroep {
  readonly titel: string;
  readonly regels: readonly JaarrekeningRegel[];
  readonly totaalCent: number;
  readonly totaalVorigJaarCent: number | null;
  readonly totaalBegrootCent: number | null;
}

export interface Jaarrekening {
  readonly vveNaam: string;
  readonly jaar: number;
  readonly boekjaarId: bigint;
  readonly status: string;
  readonly vorigJaar: number | null;
  readonly heeftBegroting: boolean;
  /** Balans: activa tegenover passiva en eigen vermogen. */
  readonly activa: JaarrekeningGroep;
  readonly passiva: JaarrekeningGroep;
  readonly eigenVermogen: JaarrekeningGroep;
  /** Staat van baten en lasten. */
  readonly baten: JaarrekeningGroep;
  readonly lasten: JaarrekeningGroep;
  readonly resultaatCent: number;
  readonly resultaatVorigJaarCent: number | null;
  readonly resultaatBegrootCent: number | null;
  readonly inBalans: boolean;
}

export interface JaarrekeningService {
  jaarrekening(vveId: bigint, boekjaarId: bigint): Promise<Jaarrekening>;
}

/**
 * Het bedrag zoals het in de jaarrekening hoort te staan: positief aan de kant
 * die bij de categorie past. Activa en lasten staan debet, de rest credit.
 */
function bedragVoorCategorie(regel: BalansRegel): number {
  const debetKant = regel.categorie === 'activa' || regel.categorie === 'lasten';
  return debetKant
    ? regel.debetTotaalCent - regel.creditTotaalCent
    : regel.creditTotaalCent - regel.debetTotaalCent;
}

function groep(
  titel: string,
  regels: readonly JaarrekeningRegel[],
  heeftVorig: boolean,
  heeftBegroting: boolean,
): JaarrekeningGroep {
  return {
    titel,
    regels,
    totaalCent: regels.reduce((s, r) => s + r.bedragCent, 0),
    totaalVorigJaarCent: heeftVorig ? regels.reduce((s, r) => s + (r.vorigJaarCent ?? 0), 0) : null,
    totaalBegrootCent: heeftBegroting ? regels.reduce((s, r) => s + (r.begrootCent ?? 0), 0) : null,
  };
}

export function maakJaarrekeningService(config: {
  readonly db: NodePgDatabase;
}): JaarrekeningService {
  const { db } = config;
  const balansSvc = maakBalansService({ db });

  return {
    async jaarrekening(vveId, boekjaarId) {
      // De kopgegevens en de begroting in één tenant-transactie; de balansen
      // hebben hun eigen transactie (ze zijn op zichzelf leesbaar).
      const kop = await inTenantTransactie(db, vveId, async (tx) => {
        const [jaarRij] = await tx
          .select({ id: boekjaar.id, jaar: boekjaar.jaar, status: boekjaar.status })
          .from(boekjaar)
          .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
          .limit(1);
        if (jaarRij === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');

        const [vveRij] = await tx
          .select({ naam: vve.naam })
          .from(vve)
          .where(eq(vve.id, vveId))
          .limit(1);

        // Het vorige boekjaar is het jaar ervóór van dezelfde VvE. Bewust op
        // `jaar` en niet op id: boekjaren hoeven niet in volgorde aangemaakt te
        // zijn (een overname voert oude jaren later in, §13.2).
        const [vorigRij] = await tx
          .select({ id: boekjaar.id, jaar: boekjaar.jaar })
          .from(boekjaar)
          .where(and(eq(boekjaar.vveId, vveId), eq(boekjaar.jaar, jaarRij.jaar - 1)))
          .limit(1);

        // Begroting van dít boekjaar; alleen een vastgestelde telt als
        // vergelijkingsmaatstaf — een concept is nog geen afspraak (AC5.1).
        const [begrotingRij] = await tx
          .select({ id: begroting.id, status: begroting.status })
          .from(begroting)
          .where(and(eq(begroting.vveId, vveId), eq(begroting.boekjaarId, boekjaarId)))
          .limit(1);

        let begrootPerRekening = new Map<bigint, number>();
        if (begrotingRij !== undefined && begrotingRij.status !== 'concept') {
          const regels = await tx
            .select({
              rekeningId: begrotingsregel.grootboekrekeningId,
              bedragCent: begrotingsregel.bedragCent,
            })
            .from(begrotingsregel)
            .where(eq(begrotingsregel.begrotingId, begrotingRij.id))
            .orderBy(asc(begrotingsregel.volgorde));
          const som = new Map<bigint, number>();
          for (const r of regels) {
            som.set(r.rekeningId, (som.get(r.rekeningId) ?? 0) + r.bedragCent);
          }
          begrootPerRekening = som;
        }

        return {
          jaar: jaarRij.jaar,
          status: jaarRij.status,
          vveNaam: vveRij?.naam ?? 'VvE',
          vorig: vorigRij ?? null,
          begrootPerRekening,
          heeftBegroting: begrootPerRekening.size > 0,
        };
      });

      const ditJaar = await balansSvc.proefSaldiBalans(vveId, boekjaarId);
      const vorigBalans =
        kop.vorig === null ? null : await balansSvc.proefSaldiBalans(vveId, kop.vorig.id);
      const vorigPerNummer = new Map(
        (vorigBalans?.regels ?? []).map((r) => [r.nummer, bedragVoorCategorie(r)]),
      );

      const heeftVorig = vorigBalans !== null;

      const maakRegels = (categorie: BalansRegel['categorie']): JaarrekeningRegel[] =>
        ditJaar.regels
          .filter((r) => r.categorie === categorie)
          .map((r) => ({
            nummer: r.nummer,
            naam: r.naam,
            isReservefonds: r.isReservefonds,
            bedragCent: bedragVoorCategorie(r),
            vorigJaarCent: heeftVorig ? (vorigPerNummer.get(r.nummer) ?? 0) : null,
            begrootCent: kop.begrootPerRekening.get(r.rekeningId) ?? null,
          }))
          // Rekeningen zonder enig bedrag in alle drie de kolommen voegen niets
          // toe aan een jaarrekening; die horen in de proefbalans (B07) thuis.
          .filter(
            (r) => r.bedragCent !== 0 || (r.vorigJaarCent ?? 0) !== 0 || (r.begrootCent ?? 0) !== 0,
          );

      const activa = groep('Activa', maakRegels('activa'), heeftVorig, kop.heeftBegroting);
      const passiva = groep('Passiva', maakRegels('passiva'), heeftVorig, kop.heeftBegroting);
      const eigenVermogen = groep(
        'Eigen vermogen',
        maakRegels('eigen_vermogen'),
        heeftVorig,
        kop.heeftBegroting,
      );
      const baten = groep('Baten', maakRegels('baten'), heeftVorig, kop.heeftBegroting);
      const lasten = groep('Lasten', maakRegels('lasten'), heeftVorig, kop.heeftBegroting);

      const resultaat = baten.totaalCent - lasten.totaalCent;
      const resultaatVorig =
        heeftVorig && baten.totaalVorigJaarCent !== null && lasten.totaalVorigJaarCent !== null
          ? baten.totaalVorigJaarCent - lasten.totaalVorigJaarCent
          : null;
      const resultaatBegroot =
        kop.heeftBegroting && baten.totaalBegrootCent !== null && lasten.totaalBegrootCent !== null
          ? baten.totaalBegrootCent - lasten.totaalBegrootCent
          : null;

      return {
        vveNaam: kop.vveNaam,
        jaar: kop.jaar,
        boekjaarId,
        status: kop.status,
        vorigJaar: kop.vorig?.jaar ?? null,
        heeftBegroting: kop.heeftBegroting,
        activa,
        passiva,
        eigenVermogen,
        baten,
        lasten,
        resultaatCent: resultaat,
        resultaatVorigJaarCent: resultaatVorig,
        resultaatBegrootCent: resultaatBegroot,
        // Zie de kop: het resultaat telt mee zolang het nog niet naar het eigen
        // vermogen is geboekt.
        inBalans: activa.totaalCent === passiva.totaalCent + eigenVermogen.totaalCent + resultaat,
      };
    },
  };
}

/** Voor de exportlaag: alle rekening-ids van een jaarrekening, in volgorde. */
export function alleRegels(jr: Jaarrekening): readonly JaarrekeningRegel[] {
  return [
    ...jr.activa.regels,
    ...jr.passiva.regels,
    ...jr.eigenVermogen.regels,
    ...jr.baten.regels,
    ...jr.lasten.regels,
  ];
}
