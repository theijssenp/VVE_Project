/**
 * Begrotings-service — blok G04 (spec §6.5, M5 · AC5.1, AC5.7).
 *
 * Één begroting per boekjaar (UNIQUE). Statusflow (AC5.1):
 *   concept → voorgesteld_alv → vastgesteld → gesloten
 * met deze regels:
 *   - regels mogen alleen in `concept` worden gewijzigd (daarna is de tekst
 *     vast, anders kan de ALV over iets anders stemmen dan het scherm toont);
 *   - vaststellen mag alleen vanuit `voorgesteld_alv`;
 *   - alleen vanuit `vastgesteld` mag nota-generatie later nota's maken (G06);
 *   - gesloten is het eindpunt (jaarafsluiting, B10).
 *
 * **Vorig-jaar-vergelijking (AC5.7-kolom):** de lijst telt per rekening de
 * boekingen van het vorige boekjaar (append-only bron, G02) naast de
 * begrotingsregels van dit jaar — realisatie naast begroting, per rekening.
 *
 * **ALV-PDF (AC5.7):** nog geen echte PDF — dit blok levert de *inhoud* van
 * de tabel (regels, totalen, exploitatie/reserve-split, vorig-jaar-vergelijking)
 * als data; de PDF-generatie zelf volgt in hetzelfde blok op de client of via
 * een latere uitbreiding (de spec-eis is de export, de datastructuur hiervoor
 * is de levering van G04).
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { begroting, begrotingsregel } from '../database/schema/begroting.js';
import { boeking, boekingsregel } from '../database/schema/boeking.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { grootboekrekening } from '../database/schema/grootboekrekening.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export interface RegelInvoer {
  readonly grootboekrekeningNummer: string;
  readonly omschrijving: string;
  /** Bedrag in centen, positief (bigint-centen, domein van F05). */
  readonly bedragCent: number;
  readonly verdeelsleutelId: bigint;
  readonly isReservefonds?: boolean | undefined;
  readonly volgorde?: number | undefined;
}

export interface BegrotingsregelRij {
  readonly id: bigint;
  readonly rekeningNummer: string;
  readonly rekeningNaam: string;
  readonly omschrijving: string;
  readonly bedragCent: number;
  readonly verdeelsleutelId: bigint;
  readonly isReservefonds: boolean;
  readonly volgorde: number;
}

export interface VergelijkingRij {
  readonly rekeningNummer: string;
  readonly rekeningNaam: string;
  /** Realisatie uit het vorige boekjaar (som van debet-lasten / credit-baten). */
  readonly vorigJaarCenten: number;
  readonly begrotingCenten: number;
}

export interface BegrotingRij {
  readonly id: bigint;
  readonly boekjaarId: bigint;
  readonly jaar: number;
  readonly status: string;
  readonly vastgesteldOp: string | null;
}

export interface BegrotingOverzicht {
  readonly begroting: BegrotingRij;
  readonly regels: readonly BegrotingsregelRij[];
  readonly totaalExploitatieCenten: number;
  readonly totaalReservefondsCenten: number;
  /** AC5.7: realisatie vorig jaar naast de begroting, per rekening. */
  readonly vergelijking: readonly VergelijkingRij[];
}

export interface BegrotingService {
  maak(
    vveId: bigint,
    boekjaarId: bigint,
    regels: readonly RegelInvoer[],
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  /** Vervangt alle regels; alleen in `concept`. */
  vervangRegels(
    vveId: bigint,
    begrotingId: bigint,
    regels: readonly RegelInvoer[],
    doorPersoonId: bigint,
  ): Promise<void>;
  /** AC5.1: statusschuif met de toegestane overgangen. */
  zetStatus(
    vveId: bigint,
    begrotingId: bigint,
    status: 'voorgesteld_alv' | 'vastgesteld' | 'gesloten',
    doorPersoonId: bigint,
  ): Promise<void>;
  detail(vveId: bigint, boekjaarId: bigint): Promise<BegrotingOverzicht>;
}

const TOEGESTANE_OVERGANGEN: Record<string, ReadonlySet<string>> = {
  concept: new Set(['voorgesteld_alv']),
  voorgesteld_alv: new Set(['vastgesteld', 'concept']),
  vastgesteld: new Set(['gesloten']),
  gesloten: new Set(),
};

export function maakBegrotingService(config: { readonly db: NodePgDatabase }): BegrotingService {
  const { db } = config;
  const audit = maakAuditService({ db });

  /** Rekeningen per nummer binnen de tenant; onbekend → InvoerFout. */
  async function rekeningMap(
    tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
    vveId: bigint,
    nummers: readonly string[],
  ): Promise<Map<string, bigint>> {
    const rijen = await tx
      .select({ id: grootboekrekening.id, nummer: grootboekrekening.nummer })
      .from(grootboekrekening)
      .where(sql`${grootboekrekening.vveId} = ${vveId}`);
    const map = new Map(rijen.map((r) => [r.nummer, r.id]));
    for (const n of [...new Set(nummers)]) {
      if (!map.has(n)) {
        throw new InvoerFout(`Grootboekrekening ${n} bestaat niet in deze VvE.`);
      }
    }
    return map;
  }

  /** Regels valideren: bedrag positief, sleutel bestaat in deze VvE. */
  function valideerRegels(regels: readonly RegelInvoer[]): void {
    if (regels.length === 0) {
      throw new InvoerFout('Een begroting heeft ten minste één regel.');
    }
    for (const r of regels) {
      if (!Number.isInteger(r.bedragCent) || r.bedragCent <= 0) {
        throw new InvoerFout(
          'Het bedrag van elke begrotingsregel is een positief geheel aantal centen.',
        );
      }
      if (r.omschrijving.trim() === '') {
        throw new InvoerFout('Elke begrotingsregel heeft een omschrijving.');
      }
    }
  }

  return {
    async maak(vveId, boekjaarId, regels, doorPersoonId) {
      valideerRegels(regels);
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [jaar] = await tx
          .select({ id: boekjaar.id, vveId: boekjaar.vveId })
          .from(boekjaar)
          .where(sql`${boekjaar.id} = ${boekjaarId} AND ${boekjaar.vveId} = ${vveId}`)
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        const [dubbel] = await tx
          .select({ id: begroting.id })
          .from(begroting)
          .where(sql`${begroting.boekjaarId} = ${boekjaarId}`)
          .limit(1);
        if (dubbel !== undefined) {
          throw new InvoerFout('Er bestaat al een begroting voor dit boekjaar.');
        }
        const rekeningen = await rekeningMap(
          tx,
          vveId,
          regels.map((r) => r.grootboekrekeningNummer),
        );
        const [rij] = await tx
          .insert(begroting)
          .values({ vveId, boekjaarId })
          .returning({ id: begroting.id });
        if (rij === undefined) throw new Error('begroting-insert leverde geen id op');
        await tx.insert(begrotingsregel).values(
          regels.map((r, i) => ({
            begrotingId: rij.id,
            grootboekrekeningId: rekeningen.get(r.grootboekrekeningNummer) ?? 0n,
            omschrijving: r.omschrijving,
            bedragCent: r.bedragCent,
            verdeelsleutelId: r.verdeelsleutelId,
            isReservefonds: r.isReservefonds ?? false,
            volgorde: r.volgorde ?? i,
          })),
        );
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'begroting.aangemaakt',
        categorie: 'financieel',
        onderwerpTabel: 'begroting',
        onderwerpId: id,
        details: { aantalRegels: regels.length },
      });
      return { id };
    },

    async vervangRegels(vveId, begrotingId, regels, doorPersoonId) {
      valideerRegels(regels);
      await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({ status: begroting.status })
          .from(begroting)
          .where(sql`${begroting.vveId} = ${vveId} AND ${begroting.id} = ${begrotingId}`)
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Begroting niet gevonden.');
        if (rij.status !== 'concept') {
          throw new InvoerFout(
            'Regels wijzigen kan alleen zolang de begroting concept is (AC5.1).',
          );
        }
        const rekeningen = await rekeningMap(
          tx,
          vveId,
          regels.map((r) => r.grootboekrekeningNummer),
        );
        // Regels zijn CASCADE-kinderen: wissen en opnieuw — de begroting is
        // concept, er is nog niets aan gekoppeld dat bewaard moet blijven.
        await tx
          .delete(begrotingsregel)
          .where(sql`${begrotingsregel.begrotingId} = ${begrotingId}`);
        await tx.insert(begrotingsregel).values(
          regels.map((r, i) => ({
            begrotingId: begrotingId,
            grootboekrekeningId: rekeningen.get(r.grootboekrekeningNummer) ?? 0n,
            omschrijving: r.omschrijving,
            bedragCent: r.bedragCent,
            verdeelsleutelId: r.verdeelsleutelId,
            isReservefonds: r.isReservefonds ?? false,
            volgorde: r.volgorde ?? i,
          })),
        );
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'begroting.regels_gewijzigd',
          categorie: 'financieel',
          onderwerpTabel: 'begroting',
          onderwerpId: begrotingId,
          details: { aantalRegels: regels.length },
        });
      });
    },

    async zetStatus(vveId, begrotingId, status, doorPersoonId) {
      await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({ id: begroting.id, status: begroting.status })
          .from(begroting)
          .where(sql`${begroting.vveId} = ${vveId} AND ${begroting.id} = ${begrotingId}`)
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Begroting niet gevonden.');
        if (!TOEGESTANE_OVERGANGEN[rij.status]?.has(status)) {
          throw new InvoerFout(
            `Status mag van "${rij.status}" niet naar "${status}" (AC5.1-flow).`,
          );
        }
        await tx
          .update(begroting)
          .set({
            status,
            ...(status === 'vastgesteld'
              ? { vastgesteldOp: new Date().toISOString().slice(0, 10) }
              : {}),
          })
          .where(sql`${begroting.id} = ${begrotingId}`);
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: `begroting.${status}`,
          categorie: 'financieel',
          onderwerpTabel: 'begroting',
          onderwerpId: begrotingId,
        });
      });
    },

    async detail(vveId, boekjaarId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({
            id: begroting.id,
            status: begroting.status,
            vastgesteldOp: begroting.vastgesteldOp,
            jaar: boekjaar.jaar,
          })
          .from(begroting)
          .innerJoin(boekjaar, eq(boekjaar.id, begroting.boekjaarId))
          .where(sql`${begroting.vveId} = ${vveId} AND ${begroting.boekjaarId} = ${boekjaarId}`)
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Begroting niet gevonden.');

        const regels = await tx
          .select({
            id: begrotingsregel.id,
            nummer: grootboekrekening.nummer,
            rekeningNaam: grootboekrekening.naam,
            omschrijving: begrotingsregel.omschrijving,
            bedragCent: begrotingsregel.bedragCent,
            verdeelsleutelId: begrotingsregel.verdeelsleutelId,
            isReservefonds: begrotingsregel.isReservefonds,
            volgorde: begrotingsregel.volgorde,
          })
          .from(begrotingsregel)
          .innerJoin(
            grootboekrekening,
            eq(grootboekrekening.id, begrotingsregel.grootboekrekeningId),
          )
          .where(sql`${begrotingsregel.begrotingId} = ${rij.id}`)
          .orderBy(asc(begrotingsregel.volgorde), asc(begrotingsregel.id));

        // AC5.7-kolom: realisatie uit het vorige boekjaar, per rekening.
        // De som neemt debet (voor lasten) en credit (voor baten) — de
        // categorie bepaalt de richting; het saldo is wat de kolom toont.
        const [vorigJaar] = await tx
          .select({ id: boekjaar.id, jaar: boekjaar.jaar })
          .from(boekjaar)
          .where(sql`${boekjaar.vveId} = ${vveId} AND ${boekjaar.jaar} = ${rij.jaar - 1}`)
          .limit(1);
        const realisatie = new Map<string, number>();
        if (vorigJaar !== undefined) {
          const regelsVorig = await tx
            .select({
              nummer: grootboekrekening.nummer,
              categorie: grootboekrekening.categorie,
              debet: sql<number>`coalesce(sum(${boekingsregel.debetCent}), 0)::int`,
              credit: sql<number>`coalesce(sum(${boekingsregel.creditCent}), 0)::int`,
            })
            .from(boekingsregel)
            .innerJoin(boeking, eq(boeking.id, boekingsregel.boekingId))
            .innerJoin(
              grootboekrekening,
              eq(grootboekrekening.id, boekingsregel.grootboekrekeningId),
            )
            .where(sql`${boeking.boekjaarId} = ${vorigJaar.id}`)
            .groupBy(grootboekrekening.nummer, grootboekrekening.categorie);
          for (const r of regelsVorig) {
            const waarde =
              r.categorie === 'lasten' || r.categorie === 'activa'
                ? r.debet - r.credit
                : r.credit - r.debet;
            realisatie.set(r.nummer, waarde);
          }
        }

        const alleNummers = new Set([...regels.map((r) => r.nummer), ...realisatie.keys()]);
        const vergelijking: VergelijkingRij[] = [];
        for (const nummer of alleNummers) {
          const regel = regels.find((r) => r.nummer === nummer);
          const naam = regel?.rekeningNaam ?? nummer;
          vergelijking.push({
            rekeningNummer: nummer,
            rekeningNaam: naam,
            vorigJaarCenten: realisatie.get(nummer) ?? 0,
            begrotingCenten: regel?.bedragCent ?? 0,
          });
        }
        vergelijking.sort((a, b) => (a.rekeningNummer < b.rekeningNummer ? -1 : 1));

        return {
          begroting: {
            id: rij.id,
            boekjaarId,
            jaar: rij.jaar,
            status: rij.status,
            vastgesteldOp: rij.vastgesteldOp,
          },
          regels: regels.map((r) => ({
            id: r.id,
            rekeningNummer: r.nummer,
            rekeningNaam: r.rekeningNaam,
            omschrijving: r.omschrijving,
            bedragCent: r.bedragCent,
            verdeelsleutelId: r.verdeelsleutelId,
            isReservefonds: r.isReservefonds,
            volgorde: r.volgorde,
          })),
          totaalExploitatieCenten: regels
            .filter((r) => !r.isReservefonds)
            .reduce((s, r) => s + r.bedragCent, 0),
          totaalReservefondsCenten: regels
            .filter((r) => r.isReservefonds)
            .reduce((s, r) => s + r.bedragCent, 0),
          vergelijking,
        };
      });
    },
  };
}
