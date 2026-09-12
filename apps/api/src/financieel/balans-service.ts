/**
 * Proefbalans, saldibalans en grootboekweergave — blok B07 (spec M9 · AC9.8).
 *
 * Drie lagen, van grof naar fijn, die samen het auditspoor vormen dat AC9.8
 * eist: vanuit een regel in de jaarrekening moet je kunnen doorklikken naar de
 * onderliggende boekingen, en van daaruit naar het brondocument.
 *
 *   1. {@link BalansService.proefSaldiBalans} — per grootboekrekening de
 *      optelling van alle debet- en creditbedragen (de *proef*balans) plus het
 *      resulterende saldo aan één kant (de *saldi*balans). In de Nederlandse
 *      praktijk staan die naast elkaar in één overzicht met vier kolommen;
 *      vandaar één methode en niet twee.
 *   2. {@link BalansService.grootboek} — de mutaties van één rekening,
 *      chronologisch, met een lopend saldo.
 *   3. {@link BalansService.boekingDetail} — de volledige boeking achter een
 *      mutatie, met de verwijzing naar de bron (`bron` + `bron_id`).
 *
 * **De controle die dit overzicht zijn naam geeft.** Een proefbalans is pas een
 * proef als je hem ook werkelijk toetst: de som van alle debetbedragen hoort
 * exact gelijk te zijn aan de som van alle creditbedragen. G02 bewaakt dat al
 * per boeking (`OnbalansFout` plus de deferred trigger), maar dat is de controle
 * op het schrijven. Dit is de controle op het lezen, over het hele boekjaar
 * heen — en die vangt wat de eerste niet kan vangen: een regel die buiten de
 * boekingsservice om is aangepast, of een migratie die iets heeft gebroken.
 * `inBalans` zegt daarom niet "dit ziet er goed uit" maar telt het na.
 *
 * **Waarom de bedragen hier als getal en niet als `Bedrag` rondgaan.** De
 * kolommen zijn `bigint`-centen en de optelling gebeurt in SQL (`sum`), niet in
 * TypeScript. Wat hieruit komt is een eindtotaal dat alleen nog getoond wordt;
 * er wordt niet verder mee gerekend. Zodra dat wél gebeurt — bijvoorbeeld in de
 * jaarrekening van B08 — hoort het via `Bedrag` te gaan (§7.3).
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { boeking, boekingsregel } from '../database/schema/boeking.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { grootboekrekening } from '../database/schema/grootboekrekening.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { NietGevondenFout } from './boekhouding.js';

/** Eén regel in de proef- en saldibalans. */
export interface BalansRegel {
  readonly rekeningId: bigint;
  readonly nummer: string;
  readonly naam: string;
  readonly categorie: 'activa' | 'passiva' | 'eigen_vermogen' | 'lasten' | 'baten';
  readonly isReservefonds: boolean;
  /** Proefbalans: de optelling van alle boekingen aan deze kant. */
  readonly debetTotaalCent: number;
  readonly creditTotaalCent: number;
  /** Saldibalans: het verschil, aan de kant waar het uitkomt. De andere is 0. */
  readonly saldoDebetCent: number;
  readonly saldoCreditCent: number;
}

export interface ProefSaldiBalans {
  readonly boekjaarId: bigint;
  readonly jaar: number;
  /** Alleen boekingen tot en met deze datum; standaard het hele boekjaar. */
  readonly peildatum: string | null;
  readonly regels: readonly BalansRegel[];
  readonly totaalDebetCent: number;
  readonly totaalCreditCent: number;
  readonly totaalSaldoDebetCent: number;
  readonly totaalSaldoCreditCent: number;
  /** Telt de proefbalans op? Zie de kop: dit wordt nageteld, niet aangenomen. */
  readonly inBalans: boolean;
}

/** Eén mutatie in de grootboekweergave van een rekening. */
export interface GrootboekMutatie {
  readonly boekingsregelId: bigint;
  readonly boekingId: bigint;
  readonly boekingNummer: string;
  readonly datum: string;
  readonly omschrijving: string;
  readonly regelOmschrijving: string | null;
  readonly wooneenheidId: bigint | null;
  readonly wooneenheidCode: string | null;
  readonly debetCent: number;
  readonly creditCent: number;
  /** Saldo ná deze mutatie, debet positief (§5.1: alles in centen). */
  readonly lopendSaldoCent: number;
  /** AC9.8: waar komt deze boeking vandaan? */
  readonly bron: string;
  readonly bronId: bigint | null;
}

export interface GrootboekWeergave {
  readonly rekeningId: bigint;
  readonly nummer: string;
  readonly naam: string;
  readonly categorie: string;
  readonly mutaties: readonly GrootboekMutatie[];
  readonly eindsaldoCent: number;
}

/** De volledige boeking achter een mutatie — de laatste stap van AC9.8. */
export interface BoekingDetail {
  readonly boekingId: bigint;
  readonly nummer: string;
  readonly datum: string;
  readonly omschrijving: string;
  readonly bron: string;
  readonly bronId: bigint | null;
  readonly vergrendeld: boolean;
  readonly regels: readonly {
    readonly rekeningId: bigint;
    readonly nummer: string;
    readonly naam: string;
    readonly omschrijving: string | null;
    readonly debetCent: number;
    readonly creditCent: number;
  }[];
  readonly totaalDebetCent: number;
  readonly totaalCreditCent: number;
}

export interface BalansService {
  proefSaldiBalans(
    vveId: bigint,
    boekjaarId: bigint,
    peildatum?: string | null,
  ): Promise<ProefSaldiBalans>;
  grootboek(vveId: bigint, boekjaarId: bigint, rekeningId: bigint): Promise<GrootboekWeergave>;
  boekingDetail(vveId: bigint, boekingId: bigint): Promise<BoekingDetail>;
}

/** `sum()` levert in pg een string (of null bij geen rijen); hier naar centen. */
function centen(waarde: unknown): number {
  if (waarde === null || waarde === undefined) return 0;
  const getal = Number(waarde);
  return Number.isFinite(getal) ? getal : 0;
}

export function maakBalansService(config: { readonly db: NodePgDatabase }): BalansService {
  const { db } = config;

  /** Controleert dat het boekjaar van deze VvE is; anders bestaat het niet. */
  async function eisBoekjaar(
    tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
    vveId: bigint,
    boekjaarId: bigint,
  ): Promise<{ id: bigint; jaar: number }> {
    const [rij] = await tx
      .select({ id: boekjaar.id, jaar: boekjaar.jaar })
      .from(boekjaar)
      .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
      .limit(1);
    if (rij === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
    return rij;
  }

  return {
    async proefSaldiBalans(vveId, boekjaarId, peildatum) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const jaar = await eisBoekjaar(tx, vveId, boekjaarId);

        // Alle rekeningen van de VvE, ook die zonder mutaties: een lege regel
        // in de proefbalans is informatie ("hier is niets op geboekt"), geen
        // reden om de rekening te verbergen.
        const rekeningen = await tx
          .select({
            rekeningId: grootboekrekening.id,
            nummer: grootboekrekening.nummer,
            naam: grootboekrekening.naam,
            categorie: grootboekrekening.categorie,
            isReservefonds: grootboekrekening.isReservefonds,
          })
          .from(grootboekrekening)
          .where(eq(grootboekrekening.vveId, vveId))
          .orderBy(asc(grootboekrekening.nummer));

        const datumFilter =
          peildatum === undefined || peildatum === null
            ? sql`true`
            : sql`${boeking.datum} <= ${peildatum}`;

        const totalen = await tx
          .select({
            rekeningId: boekingsregel.grootboekrekeningId,
            debet: sql<string>`sum(${boekingsregel.debetCent})`,
            credit: sql<string>`sum(${boekingsregel.creditCent})`,
          })
          .from(boekingsregel)
          .innerJoin(boeking, eq(boeking.id, boekingsregel.boekingId))
          .where(and(eq(boeking.vveId, vveId), eq(boeking.boekjaarId, boekjaarId), datumFilter))
          .groupBy(boekingsregel.grootboekrekeningId);

        const perRekening = new Map(totalen.map((t) => [t.rekeningId, t]));

        let totaalDebet = 0;
        let totaalCredit = 0;
        let totaalSaldoDebet = 0;
        let totaalSaldoCredit = 0;

        const regels: BalansRegel[] = rekeningen.map((r) => {
          const t = perRekening.get(r.rekeningId);
          const debet = centen(t?.debet);
          const credit = centen(t?.credit);
          // Het saldo staat aan één kant. Een rekening met debet 500 en credit
          // 200 heeft saldo 300 debet; de creditkolom blijft dan leeg. Dat is
          // wat een saldibalans onderscheidt van een proefbalans.
          const verschil = debet - credit;
          const saldoDebet = verschil > 0 ? verschil : 0;
          const saldoCredit = verschil < 0 ? -verschil : 0;
          totaalDebet += debet;
          totaalCredit += credit;
          totaalSaldoDebet += saldoDebet;
          totaalSaldoCredit += saldoCredit;
          return {
            ...r,
            debetTotaalCent: debet,
            creditTotaalCent: credit,
            saldoDebetCent: saldoDebet,
            saldoCreditCent: saldoCredit,
          };
        });

        return {
          boekjaarId: jaar.id,
          jaar: jaar.jaar,
          peildatum: peildatum ?? null,
          regels,
          totaalDebetCent: totaalDebet,
          totaalCreditCent: totaalCredit,
          totaalSaldoDebetCent: totaalSaldoDebet,
          totaalSaldoCreditCent: totaalSaldoCredit,
          // Beide kanten moeten kloppen: de tellingen én de saldi.
          inBalans: totaalDebet === totaalCredit && totaalSaldoDebet === totaalSaldoCredit,
        };
      });
    },

    async grootboek(vveId, boekjaarId, rekeningId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        await eisBoekjaar(tx, vveId, boekjaarId);

        const [rekening] = await tx
          .select({
            id: grootboekrekening.id,
            nummer: grootboekrekening.nummer,
            naam: grootboekrekening.naam,
            categorie: grootboekrekening.categorie,
          })
          .from(grootboekrekening)
          .where(and(eq(grootboekrekening.id, rekeningId), eq(grootboekrekening.vveId, vveId)))
          .limit(1);
        if (rekening === undefined) throw new NietGevondenFout('Grootboekrekening niet gevonden.');

        const rijen = await tx
          .select({
            boekingsregelId: boekingsregel.id,
            boekingId: boeking.id,
            boekingNummer: boeking.nummer,
            datum: boeking.datum,
            omschrijving: boeking.omschrijving,
            regelOmschrijving: boekingsregel.omschrijving,
            wooneenheidId: boekingsregel.wooneenheidId,
            wooneenheidCode: wooneenheid.code,
            debetCent: boekingsregel.debetCent,
            creditCent: boekingsregel.creditCent,
            bron: boeking.bron,
            bronId: boeking.bronId,
          })
          .from(boekingsregel)
          .innerJoin(boeking, eq(boeking.id, boekingsregel.boekingId))
          .leftJoin(wooneenheid, eq(wooneenheid.id, boekingsregel.wooneenheidId))
          .where(
            and(
              eq(boeking.vveId, vveId),
              eq(boeking.boekjaarId, boekjaarId),
              eq(boekingsregel.grootboekrekeningId, rekeningId),
            ),
          )
          // Op datum, en binnen een datum op boekingsnummer: dat is de volgorde
          // waarin geboekt is. Sorteren op id alleen zou een memoriaalboeking
          // met terugwerkende datum onderaan zetten.
          .orderBy(asc(boeking.datum), asc(boeking.nummer), asc(boekingsregel.id));

        let saldo = 0;
        const mutaties: GrootboekMutatie[] = rijen.map((r) => {
          saldo += r.debetCent - r.creditCent;
          return { ...r, lopendSaldoCent: saldo };
        });

        return {
          rekeningId: rekening.id,
          nummer: rekening.nummer,
          naam: rekening.naam,
          categorie: rekening.categorie,
          mutaties,
          eindsaldoCent: saldo,
        };
      });
    },

    async boekingDetail(vveId, boekingId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [kop] = await tx
          .select({
            boekingId: boeking.id,
            nummer: boeking.nummer,
            datum: boeking.datum,
            omschrijving: boeking.omschrijving,
            bron: boeking.bron,
            bronId: boeking.bronId,
            vergrendeld: boeking.vergrendeld,
          })
          .from(boeking)
          .where(and(eq(boeking.id, boekingId), eq(boeking.vveId, vveId)))
          .limit(1);
        if (kop === undefined) throw new NietGevondenFout('Boeking niet gevonden.');

        const regels = await tx
          .select({
            rekeningId: grootboekrekening.id,
            nummer: grootboekrekening.nummer,
            naam: grootboekrekening.naam,
            omschrijving: boekingsregel.omschrijving,
            debetCent: boekingsregel.debetCent,
            creditCent: boekingsregel.creditCent,
          })
          .from(boekingsregel)
          .innerJoin(grootboekrekening, eq(grootboekrekening.id, boekingsregel.grootboekrekeningId))
          .where(eq(boekingsregel.boekingId, boekingId))
          .orderBy(asc(boekingsregel.id));

        return {
          ...kop,
          regels,
          totaalDebetCent: regels.reduce((som, r) => som + r.debetCent, 0),
          totaalCreditCent: regels.reduce((som, r) => som + r.creditCent, 0),
        };
      });
    },
  };
}
