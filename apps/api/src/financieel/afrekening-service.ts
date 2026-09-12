/**
 * Afrekening servicekosten — blok B09 (spec M9 · AC9.5–9.6, tests #22–23).
 *
 * Aan het eind van een boekjaar staat tegenover de werkelijke kosten wat de
 * eigenaren als voorschot in rekening gebracht hebben gekregen. Het verschil is
 * per eenheid te vorderen of te restitueren.
 *
 *   werkelijke kosten (toegerekend via de verdeelsleutel)
 * − in rekening gebrachte voorschotten
 * = saldo (positief: nog te betalen, negatief: terug te ontvangen)
 *
 * **Waarom "in rekening gebracht" en niet "betaald".** AC9.5 spreekt van
 * betaalde voorschotten, maar in de VvE-praktijk rekent de afrekening af tegen
 * wat er *genoteerd* is, niet tegen wat er binnen is. Een eigenaar die zijn
 * bijdrage niet betaalde, heeft dat bedrag nog openstaan als debiteur; zou de
 * afrekening zijn onbetaalde voorschot negeren, dan kreeg hij het tweemaal in
 * rekening — één keer als openstaande nota en één keer als afrekeningstekort.
 * Die keuze staat hier omdat hij het verschil maakt tussen een kloppende en een
 * dubbeltellende administratie.
 *
 * **Welke sleutel hoort bij welke kostenpost.** De begroting legt per
 * kostenpost een verdeelsleutel vast (AC4.3). De afrekening volgt diezelfde
 * toewijzing voor de werkelijke kosten: zo wordt afgerekend volgens de sleutel
 * waarover de ALV heeft besloten, en niet volgens een sleutel die achteraf is
 * gekozen. Een kostenrekening waarvoor niets begroot is, valt terug op de
 * standaardsleutel — anders zou een onvoorziene post stilletjes buiten de
 * afrekening blijven.
 *
 * **Eigenaarswissel (AC9.6, test #23).** Wisselt de eigenaar binnen het jaar,
 * dan wordt het saldo van die eenheid over de dagen verdeeld: elke eigenaar
 * draagt naar rato van de dagen dat hij eigenaar was. De verdeling loopt via de
 * grootste-restmethode van F05, zodat de delen exact optellen tot het geheel —
 * dat is wat test #23 natelt.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag, grootsteRestVerdeler } from '@vve/domein';

import { begroting, begrotingsregel } from '../database/schema/begroting.js';
import { boeking, boekingsregel } from '../database/schema/boeking.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { eigenaarschap } from '../database/schema/eigenaarschap.js';
import { grootboekrekening } from '../database/schema/grootboekrekening.js';
import { nota } from '../database/schema/nota.js';
import { persoon } from '../database/schema/persoon.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { gewichten } from './verdeelsleutel-service.js';

/** Het deel van één eigenaar in de afrekening van een eenheid (AC9.6). */
export interface EigenaarDeel {
  readonly persoonId: bigint;
  readonly naam: string;
  readonly vanaf: string;
  readonly totEnMet: string;
  readonly dagen: number;
  readonly saldoCent: number;
}

export interface AfrekeningEenheid {
  readonly wooneenheidId: bigint;
  readonly code: string;
  /** Werkelijke kosten, toegerekend via de verdeelsleutels. */
  readonly kostenCent: number;
  /** In rekening gebrachte voorschotten (de nota's van dit boekjaar). */
  readonly voorschotCent: number;
  /** Positief: nog te betalen. Negatief: terug te ontvangen. */
  readonly saldoCent: number;
  /**
   * Meer dan één deel zodra de eigenaar binnen het jaar wisselde (AC9.6). De
   * delen tellen exact op tot `saldoCent`.
   */
  readonly delen: readonly EigenaarDeel[];
}

export interface Afrekening {
  readonly boekjaarId: bigint;
  readonly jaar: number;
  readonly startDatum: string;
  readonly eindDatum: string;
  readonly totaalKostenCent: number;
  readonly totaalVoorschotCent: number;
  /** Kosten min voorschotten; de tegenhanger van het exploitatieresultaat. */
  readonly totaalSaldoCent: number;
  readonly eenheden: readonly AfrekeningEenheid[];
  /** Kostenrekeningen zonder begrote sleutel; verdeeld via de standaardsleutel. */
  readonly zonderEigenSleutel: readonly string[];
}

export interface AfrekeningService {
  afrekening(vveId: bigint, boekjaarId: bigint): Promise<Afrekening>;
}

/** Dagen tussen twee kalenderdata, beide inclusief. */
export function dagenInclusief(vanaf: string, totEnMet: string): number {
  const van = Date.UTC(
    Number(vanaf.slice(0, 4)),
    Number(vanaf.slice(5, 7)) - 1,
    Number(vanaf.slice(8, 10)),
  );
  const tot = Date.UTC(
    Number(totEnMet.slice(0, 4)),
    Number(totEnMet.slice(5, 7)) - 1,
    Number(totEnMet.slice(8, 10)),
  );
  if (tot < van) return 0;
  return Math.round((tot - van) / 86_400_000) + 1;
}

/** De latere van twee kalenderdata (tekstvergelijking volstaat op ISO-vorm). */
function laatste(a: string, b: string): string {
  return a > b ? a : b;
}
function vroegste(a: string, b: string): string {
  return a < b ? a : b;
}

export function maakAfrekeningService(config: { readonly db: NodePgDatabase }): AfrekeningService {
  const { db } = config;

  return {
    async afrekening(vveId, boekjaarId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [jaar] = await tx
          .select({
            id: boekjaar.id,
            jaar: boekjaar.jaar,
            startDatum: boekjaar.startDatum,
            eindDatum: boekjaar.eindDatum,
          })
          .from(boekjaar)
          .where(and(eq(boekjaar.id, boekjaarId), eq(boekjaar.vveId, vveId)))
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');

        const eenheden = await tx
          .select({ id: wooneenheid.id, code: wooneenheid.code })
          .from(wooneenheid)
          .where(eq(wooneenheid.vveId, vveId))
          .orderBy(asc(wooneenheid.code));
        if (eenheden.length === 0) {
          throw new InvoerFout('Deze VvE heeft nog geen eenheden; afrekenen kan niet.');
        }

        // 1. Werkelijke kosten per lastenrekening over dit boekjaar.
        const kostenPerRekening = await tx
          .select({
            rekeningId: grootboekrekening.id,
            nummer: grootboekrekening.nummer,
            debet: sql<string | null>`sum(${boekingsregel.debetCent})`,
            credit: sql<string | null>`sum(${boekingsregel.creditCent})`,
          })
          .from(boekingsregel)
          .innerJoin(boeking, eq(boeking.id, boekingsregel.boekingId))
          .innerJoin(grootboekrekening, eq(grootboekrekening.id, boekingsregel.grootboekrekeningId))
          .where(
            and(
              eq(boeking.vveId, vveId),
              eq(boeking.boekjaarId, boekjaarId),
              eq(grootboekrekening.categorie, 'lasten'),
            ),
          )
          .groupBy(grootboekrekening.id, grootboekrekening.nummer);

        // 2. De sleutel per kostenrekening, uit de vastgestelde begroting.
        const [begrotingRij] = await tx
          .select({ id: begroting.id, status: begroting.status })
          .from(begroting)
          .where(and(eq(begroting.vveId, vveId), eq(begroting.boekjaarId, boekjaarId)))
          .limit(1);

        const sleutelPerRekening = new Map<bigint, bigint>();
        if (begrotingRij !== undefined && begrotingRij.status !== 'concept') {
          const regels = await tx
            .select({
              rekeningId: begrotingsregel.grootboekrekeningId,
              sleutelId: begrotingsregel.verdeelsleutelId,
            })
            .from(begrotingsregel)
            .where(eq(begrotingsregel.begrotingId, begrotingRij.id));
          for (const r of regels) sleutelPerRekening.set(r.rekeningId, r.sleutelId);
        }

        // Zonder begrote sleutel valt een post terug op de eerste sleutel van de
        // VvE — meestal het breukdeel. Beter dan hem overslaan: dan zou een
        // onvoorziene kostenpost stil buiten de afrekening blijven.
        const [standaard] = await tx
          // `min()` over nul rijen levert NULL; het type zegt dat er nu ook bij.
          .select({ id: sql<string | null>`min(id)::text` })
          .from(sql`verdeelsleutel`)
          .where(sql`vve_id = ${vveId} and actief = true`);
        const standaardSleutel =
          standaard?.id === null || standaard?.id === undefined ? null : BigInt(standaard.id);

        // 3. Kosten per eenheid: elke post over zijn eigen sleutel verdelen.
        const kostenPerEenheid = new Map<bigint, number>();
        for (const e of eenheden) kostenPerEenheid.set(e.id, 0);
        const zonderEigenSleutel: string[] = [];
        let totaalKosten = 0;

        for (const post of kostenPerRekening) {
          const bedrag = Number(post.debet ?? 0) - Number(post.credit ?? 0);
          if (bedrag === 0) continue;
          totaalKosten += bedrag;

          const sleutelId = sleutelPerRekening.get(post.rekeningId) ?? standaardSleutel;
          if (!sleutelPerRekening.has(post.rekeningId)) zonderEigenSleutel.push(post.nummer);
          if (sleutelId === null) {
            throw new InvoerFout(
              `Kostenpost ${post.nummer} heeft geen verdeelsleutel en er is geen sleutel om op terug te vallen.`,
            );
          }

          const gewichtenMap = await gewichten(tx, vveId, sleutelId);
          const deelnemers = [...gewichtenMap.entries()].filter(([id]) => kostenPerEenheid.has(id));
          if (deelnemers.length === 0) continue;

          // Grootste-restmethode (§5.2): de som van de delen is exact het bedrag.
          const delen = grootsteRestVerdeler.verdeel(Bedrag.vanCenten(bedrag), new Map(deelnemers));
          for (const [eenheidId, deel] of delen) {
            kostenPerEenheid.set(eenheidId, (kostenPerEenheid.get(eenheidId) ?? 0) + deel.centen);
          }
        }

        // 4. In rekening gebrachte voorschotten per eenheid: de nota's van dit
        //    boekjaar. Creditnota's tellen negatief mee via hun eigen bedrag.
        const voorschotten = await tx
          .select({
            wooneenheidId: nota.wooneenheidId,
            som: sql<string | null>`sum(${nota.bedragCent})`,
          })
          .from(nota)
          .where(and(eq(nota.vveId, vveId), eq(nota.boekjaarId, boekjaarId)))
          .groupBy(nota.wooneenheidId);
        const voorschotPerEenheid = new Map(
          voorschotten.map((v) => [v.wooneenheidId, Number(v.som ?? 0)]),
        );

        // 5. Per eenheid het saldo, en zo nodig de verdeling over eigenaren.
        const resultaat: AfrekeningEenheid[] = [];
        let totaalVoorschot = 0;

        for (const e of eenheden) {
          const kosten = kostenPerEenheid.get(e.id) ?? 0;
          const voorschot = voorschotPerEenheid.get(e.id) ?? 0;
          totaalVoorschot += voorschot;
          const saldo = kosten - voorschot;

          const perioden = await tx
            .select({
              persoonId: eigenaarschap.persoonId,
              achternaam: persoon.achternaam,
              vanaf: sql<string>`lower(${eigenaarschap.periode})::text`,
              // Een lopend eigendom heeft geen bovengrens: `upper()` is dan NULL.
              tot: sql<string | null>`upper(${eigenaarschap.periode})::text`,
            })
            .from(eigenaarschap)
            .innerJoin(persoon, eq(persoon.id, eigenaarschap.persoonId))
            .where(
              and(
                eq(eigenaarschap.vveId, vveId),
                eq(eigenaarschap.wooneenheidId, e.id),
                // Overlap met het boekjaar; `daterange` is halfopen, vandaar de
                // vergelijking met de dag ná het einde.
                sql`${eigenaarschap.periode} && daterange(${jaar.startDatum}, (${jaar.eindDatum}::date + 1), '[)')`,
              ),
            )
            .orderBy(asc(sql`lower(${eigenaarschap.periode})`));

          const delen: EigenaarDeel[] = [];
          if (perioden.length > 0) {
            const stukken = perioden.map((p) => {
              const vanaf = laatste(p.vanaf, jaar.startDatum);
              // `upper` van een halfopen range is de dag ná het einde; en een
              // lopend eigendom heeft geen bovengrens.
              const totExclusief = p.tot;
              const totEnMet =
                totExclusief === null
                  ? jaar.eindDatum
                  : vroegste(
                      new Date(Date.parse(totExclusief) - 86_400_000).toISOString().slice(0, 10),
                      jaar.eindDatum,
                    );
              return {
                persoonId: p.persoonId,
                naam: p.achternaam,
                vanaf,
                totEnMet,
                dagen: dagenInclusief(vanaf, totEnMet),
              };
            });
            const totaalDagen = stukken.reduce((s, d) => s + d.dagen, 0);
            if (totaalDagen > 0) {
              // De verdeler werkt op eenheid-ids; hier zijn de "eenheden" de
              // opeenvolgende eigenaarsperioden. De index als sleutel houdt de
              // volgorde intact, ook als dezelfde persoon twee perioden heeft.
              const verdeeld = grootsteRestVerdeler.verdeel(
                Bedrag.vanCenten(saldo),
                new Map(stukken.map((d, i) => [BigInt(i), d.dagen])),
              );
              stukken.forEach((d, i) => {
                delen.push({ ...d, saldoCent: verdeeld.get(BigInt(i))?.centen ?? 0 });
              });
            }
          }

          resultaat.push({
            wooneenheidId: e.id,
            code: e.code,
            kostenCent: kosten,
            voorschotCent: voorschot,
            saldoCent: saldo,
            delen,
          });
        }

        return {
          boekjaarId,
          jaar: jaar.jaar,
          startDatum: jaar.startDatum,
          eindDatum: jaar.eindDatum,
          totaalKostenCent: totaalKosten,
          totaalVoorschotCent: totaalVoorschot,
          totaalSaldoCent: totaalKosten - totaalVoorschot,
          eenheden: resultaat,
          zonderEigenSleutel: [...new Set(zonderEigenSleutel)].sort(),
        };
      });
    },
  };
}
