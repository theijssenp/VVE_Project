/**
 * Boekjaar afsluiten — blok B10 (spec M9 · AC9.3, AC9.7, §7.4).
 *
 * G02 zette de status op `afgesloten` en liet de fysieke vergrendeling
 * uitdrukkelijk aan dit blok over. Hier gebeuren de drie dingen die afsluiten
 * tot een afsluiting maken:
 *
 *   1. **Resultaatbestemming.** Het resultaat van het jaar — baten min lasten —
 *      wordt overgeboekt naar het eigen vermogen, of naar het reservefonds voor
 *      het deel dat de ALV daaraan toewijst. Dáárna zijn de resultaatrekeningen
 *      leeg en klopt de balans zonder losse resultaatpost.
 *   2. **Vergrendelen.** Elke boeking van het jaar krijgt `vergrendeld = true`.
 *      De append-only rechten van G02 verhinderden al het wíjzigen van een
 *      boeking; deze vlag maakt zichtbaar dat het jaar dicht is, ook voor code
 *      die later langs een andere weg zou willen boeken.
 *   3. **Status en auditregel**, zoals G02 die al had.
 *
 * **Volgorde is hier geen detail.** De resultaatboeking hoort ín het jaar dat
 * wordt afgesloten, dus die moet gebeuren vóór de vergrendeling en vóór de
 * statuswissel — anders weigert de boekingsservice hem (§6.7: boeken kan alleen
 * in een open jaar) en zou de afsluiting zichzelf blokkeren.
 *
 * **Een jaar dat niet sluit, sluit niet.** Vóór alles wordt de balans getoetst
 * via de jaarrekening. Een boekjaar met een onbalans afsluiten betekent die
 * onbalans voor altijd vastleggen; dan is weigeren het enige juiste.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag } from '@vve/domein';

import { boeking } from '../database/schema/boeking.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { kascommissieVerklaring } from '../database/schema/kascommissie.js';
import { persoon } from '../database/schema/persoon.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout, Regel, maakBoekhouding } from './boekhouding.js';
import { maakJaarrekeningService } from './jaarrekening-service.js';
import { maakBalansService } from './balans-service.js';

/** Rekeningnummers uit het standaardschema (§5.7). */
const REKENING_ALGEMENE_RESERVE = '0500';
const REKENING_RESERVEFONDS = '0600';

export interface AfsluitInvoer {
  /**
   * Deel van het resultaat dat naar het reservefonds gaat (AC9.3). De rest
   * gaat naar de algemene reserve. Standaard nul: een VvE die niets opgeeft
   * doteert niet stilzwijgend.
   */
  readonly naarReservefondsCent?: number;
}

export interface AfsluitUitkomst {
  readonly aantalBoekingen: number;
  readonly aantalVergrendeld: number;
  readonly resultaatCent: number;
  readonly naarReservefondsCent: number;
  readonly naarAlgemeneReserveCent: number;
  /** Het nummer van de resultaatboeking, of null als het resultaat nul was. */
  readonly resultaatBoekingNummer: string | null;
}

export interface KascommissieDossier {
  readonly boekjaarId: bigint;
  readonly jaar: number;
  readonly status: string;
  /** Alle boekingen van het jaar, met bron voor de doorklik (AC9.8). */
  readonly boekingen: readonly {
    readonly id: bigint;
    readonly nummer: string;
    readonly datum: string;
    readonly omschrijving: string;
    readonly bron: string;
    readonly bronId: bigint | null;
    readonly vergrendeld: boolean;
    readonly totaalCent: number;
  }[];
  /** Saldi van de liquide middelen op de einddatum van het jaar. */
  readonly banksaldi: readonly { nummer: string; naam: string; saldoCent: number }[];
  readonly verklaringen: readonly {
    readonly persoonId: bigint;
    readonly naam: string;
    readonly akkoord: boolean;
    readonly bevindingen: string | null;
    readonly getekendOp: Date;
  }[];
}

export interface AfsluitingService {
  sluitAf(
    vveId: bigint,
    boekjaarId: bigint,
    invoer: AfsluitInvoer,
    doorPersoonId: bigint,
  ): Promise<AfsluitUitkomst>;
  /** AC9.7: alles wat de kascommissie nodig heeft, op één plek. */
  kascommissieDossier(vveId: bigint, boekjaarId: bigint): Promise<KascommissieDossier>;
  /** AC9.7: aftekenen, met of zonder akkoord. */
  tekenAf(
    vveId: bigint,
    boekjaarId: bigint,
    invoer: { akkoord: boolean; bevindingen?: string | null },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
}

export function maakAfsluitingService(config: { readonly db: NodePgDatabase }): AfsluitingService {
  const { db } = config;
  const audit = maakAuditService({ db });
  const boekhouding = maakBoekhouding({ db });
  const jaarrekeningSvc = maakJaarrekeningService({ db });
  const balansSvc = maakBalansService({ db });

  return {
    async sluitAf(vveId, boekjaarId, invoer, doorPersoonId) {
      // 1. Mag dit jaar dicht? Status eerst, dan de inhoudelijke toets.
      const status = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({ status: boekjaar.status, eindDatum: boekjaar.eindDatum })
          .from(boekjaar)
          .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        if (rij.status === 'afgesloten') throw new InvoerFout('Dit boekjaar is al afgesloten.');
        if (rij.status !== 'open') {
          throw new InvoerFout('Alleen een open boekjaar kan worden afgesloten.');
        }
        return rij;
      });

      const jaarrekening = await jaarrekeningSvc.jaarrekening(vveId, boekjaarId);
      if (!jaarrekening.inBalans) {
        throw new InvoerFout(
          'De balans van dit boekjaar sluit niet; afsluiten zou de onbalans vastleggen.',
        );
      }

      const resultaat = jaarrekening.resultaatCent;
      const naarReserve = invoer.naarReservefondsCent ?? 0;
      if (naarReserve !== 0) {
        if (resultaat <= 0) {
          throw new InvoerFout(
            'Doteren aan het reservefonds kan alleen uit een positief resultaat.',
          );
        }
        if (naarReserve < 0 || naarReserve > resultaat) {
          throw new InvoerFout('De dotatie past niet binnen het resultaat van dit jaar.');
        }
      }
      const naarAlgemeen = resultaat - naarReserve;

      // 2. Resultaatbestemming boeken — vóór de vergrendeling, zie de kop.
      //
      // Dit is een echte afsluitboeking: elke baten- en lastenrekening wordt
      // tegen zichzelf ingeboekt zodat hij op nul komt, en het verschil landt
      // op het eigen vermogen. Alleen het saldo naar 0500 boeken zou de
      // resultaatrekeningen laten staan — dan telt het volgende jaar er
      // vrolijk overheen.
      let resultaatBoekingNummer: string | null = null;
      const sluitRegels = [
        // Baten staan credit; om ze te sluiten gaan ze debet. Een baten-
        // rekening met een negatief bedrag (per saldo debet) draait mee om.
        ...jaarrekening.baten.regels
          .filter((r) => r.bedragCent !== 0)
          .map((r) =>
            r.bedragCent > 0
              ? Regel.debet(r.nummer, Bedrag.vanCenten(r.bedragCent))
              : Regel.credit(r.nummer, Bedrag.vanCenten(-r.bedragCent)),
          ),
        // Lasten staan debet; die gaan credit.
        ...jaarrekening.lasten.regels
          .filter((r) => r.bedragCent !== 0)
          .map((r) =>
            r.bedragCent > 0
              ? Regel.credit(r.nummer, Bedrag.vanCenten(r.bedragCent))
              : Regel.debet(r.nummer, Bedrag.vanCenten(-r.bedragCent)),
          ),
      ];

      if (sluitRegels.length > 0 || resultaat !== 0) {
        // Het resultaat naar het eigen vermogen: positief vermeerdert het
        // (credit), negatief vermindert het (debet).
        if (resultaat > 0) {
          if (naarReserve > 0) {
            sluitRegels.push(Regel.credit(REKENING_RESERVEFONDS, Bedrag.vanCenten(naarReserve)));
          }
          if (naarAlgemeen > 0) {
            sluitRegels.push(
              Regel.credit(REKENING_ALGEMENE_RESERVE, Bedrag.vanCenten(naarAlgemeen)),
            );
          }
        } else if (resultaat < 0) {
          sluitRegels.push(Regel.debet(REKENING_ALGEMENE_RESERVE, Bedrag.vanCenten(-resultaat)));
        }

        if (sluitRegels.length > 0) {
          const uit = await boekhouding.boek(
            vveId,
            boekjaarId,
            {
              datum: status.eindDatum,
              omschrijving: `Resultaatbestemming boekjaar ${String(jaarrekening.jaar)}`,
              bron: 'memoriaal',
              regels: sluitRegels,
            },
            doorPersoonId,
          );
          resultaatBoekingNummer = uit.nummer;
        }
      }

      // 3. Vergrendelen, status, audit — in één transactie.
      return inTenantTransactie(db, vveId, async (tx) => {
        const vergrendeld = await tx
          .update(boeking)
          .set({ vergrendeld: true })
          .where(and(eq(boeking.vveId, vveId), eq(boeking.boekjaarId, boekjaarId)))
          .returning({ id: boeking.id });

        await tx
          .update(boekjaar)
          .set({ status: 'afgesloten', afgeslotenOp: new Date() })
          .where(eq(boekjaar.id, boekjaarId));

        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'boekjaar.afgesloten',
          categorie: 'financieel',
          onderwerpTabel: 'boekjaar',
          onderwerpId: boekjaarId,
          details: {
            aantalBoekingen: vergrendeld.length,
            resultaatCent: resultaat,
            naarReservefondsCent: naarReserve,
            naarAlgemeneReserveCent: naarAlgemeen,
            resultaatBoeking: resultaatBoekingNummer,
          },
        });

        return {
          aantalBoekingen: vergrendeld.length,
          aantalVergrendeld: vergrendeld.length,
          resultaatCent: resultaat,
          naarReservefondsCent: naarReserve,
          naarAlgemeneReserveCent: naarAlgemeen,
          resultaatBoekingNummer,
        };
      });
    },

    async kascommissieDossier(vveId, boekjaarId) {
      const balans = await balansSvc.proefSaldiBalans(vveId, boekjaarId);

      return inTenantTransactie(db, vveId, async (tx) => {
        const [jaar] = await tx
          .select({ id: boekjaar.id, jaar: boekjaar.jaar, status: boekjaar.status })
          .from(boekjaar)
          .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');

        const boekingen = await tx
          .select({
            id: boeking.id,
            nummer: boeking.nummer,
            datum: boeking.datum,
            omschrijving: boeking.omschrijving,
            bron: boeking.bron,
            bronId: boeking.bronId,
            vergrendeld: boeking.vergrendeld,
            totaalCent: sql<string | null>`(
              select sum(r.debet_cent) from boekingsregel r where r.boeking_id = ${boeking.id}
            )`,
          })
          .from(boeking)
          .where(and(eq(boeking.vveId, vveId), eq(boeking.boekjaarId, boekjaarId)))
          .orderBy(boeking.datum, boeking.nummer);

        const verklaringen = await tx
          .select({
            persoonId: kascommissieVerklaring.persoonId,
            naam: persoon.achternaam,
            akkoord: kascommissieVerklaring.akkoord,
            bevindingen: kascommissieVerklaring.bevindingen,
            getekendOp: kascommissieVerklaring.getekendOp,
          })
          .from(kascommissieVerklaring)
          .innerJoin(persoon, eq(persoon.id, kascommissieVerklaring.persoonId))
          .where(
            and(
              eq(kascommissieVerklaring.vveId, vveId),
              eq(kascommissieVerklaring.boekjaarId, boekjaarId),
            ),
          );

        return {
          boekjaarId,
          jaar: jaar.jaar,
          status: jaar.status,
          boekingen: boekingen.map((b) => ({
            ...b,
            totaalCent: Number(b.totaalCent ?? 0),
          })),
          // Liquide middelen: de 1000-reeks uit §5.7. De kascommissie vergelijkt
          // deze saldi met de bankafschriften; dat is de kern van haar werk.
          banksaldi: balans.regels
            .filter((r) => r.nummer.startsWith('1') && r.nummer < '1300')
            .map((r) => ({
              nummer: r.nummer,
              naam: r.naam,
              saldoCent: r.saldoDebetCent - r.saldoCreditCent,
            })),
          verklaringen,
        };
      });
    },

    async tekenAf(vveId, boekjaarId, invoer, doorPersoonId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [jaar] = await tx
          .select({ id: boekjaar.id })
          .from(boekjaar)
          .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');

        // Opnieuw tekenen overschrijft de eigen verklaring; dat is geen fout
        // maar een herziening — bijvoorbeeld nadat een bevinding is opgelost.
        const [rij] = await tx
          .insert(kascommissieVerklaring)
          .values({
            vveId,
            boekjaarId,
            persoonId: doorPersoonId,
            akkoord: invoer.akkoord,
            bevindingen: invoer.bevindingen ?? null,
          })
          .onConflictDoUpdate({
            target: [kascommissieVerklaring.boekjaarId, kascommissieVerklaring.persoonId],
            set: {
              akkoord: invoer.akkoord,
              bevindingen: invoer.bevindingen ?? null,
              getekendOp: new Date(),
            },
          })
          .returning({ id: kascommissieVerklaring.id });
        if (rij === undefined) throw new Error('verklaring opslaan leverde geen id op');

        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: invoer.akkoord ? 'kascommissie.akkoord' : 'kascommissie.bezwaar',
          categorie: 'financieel',
          onderwerpTabel: 'kascommissie_verklaring',
          onderwerpId: rij.id,
        });
        return rij;
      });
    },
  };
}
