/**
 * Nota-service — blok G06 (spec §6.6, §5.3, M6 · AC6.1–AC6.2 · test #10).
 *
 * Van bijdrageschema (G05, jaarbedragen per eenheid) naar nota per eenheid
 * per periode. Twee verdelingen zijn al bewezen; hier gebeurt de tweede
 * verdeling van §5.3 (jaarbedrag → N perioden, grootste-restmethode, rest-
 * centen in de eerste maanden) alleen op de periode die gevraagd wordt.
 *
 * **Nummerreeks (test #10, concurrency):** `SELECT count(*) … FOR UPDATE` op
 * de boekjaar-rij binnen de tenant-transactie vergrendelt de reeks; het
 * volgnummer loopt op onder de rijvergrendeling en `UNIQUE (vve_id, nummer)`
 * vangt hard af wat er nog doorheen glipt. Geen dubbele nummers, geen
 * stilte-herprobeeringen.
 *
 * **Betalingskenmerk (AC6.2):** `NOTA{nummer}` — uniek per VvE (UNIQUE-
 * constraint), machinaal afletterbaar (B05-stap 1 zoekt hem in de
 * bankomschrijving). Betaalwijze default `overboeking`; de incassoroute
 * (pain.008, AC8.3) komt in M8 en zet `incasso` bij uitgifte.
 *
 * **Idempotentie:** een tweede generatie voor dezelfde periode (zelfde
 * type/boekjaar/van/tot) levert 0 nieuwe nota's op — herhaald indrukken van
 * de knop voegt niets toe.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag, grootsteRestVerdeler } from '@vve/domein';

import { betaling, betalingKoppeling } from '../database/schema/betaling.js';
import { bijdrageRegel, bijdrageSchema } from '../database/schema/bijdrage.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { eigenaarschap } from '../database/schema/eigenaarschap.js';
import { nota, notaRegel } from '../database/schema/nota.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export interface NotaRij {
  readonly id: bigint;
  readonly nummer: string;
  readonly eenheidCode: string;
  readonly periodeVan: string | null;
  readonly periodeTot: string | null;
  readonly factuurdatum: string;
  readonly vervaldatum: string;
  readonly bedragCent: number;
  readonly openstaandCent: number;
  readonly betaalwijze: string;
  readonly betalingskenmerk: string;
  readonly status: string;
}

export interface NotaService {
  /**
   * AC6.1: genereert nota's voor één periode van het boekjaar, voor elke
   * eenheid met een bijdrageregel en een eigenaar op de factuurdatum.
   * Idempotent per periode: een tweede generatie met dezelfde van/tot levert
   * 0 nieuwe nota's op.
   */
  genereerPeriode(
    vveId: bigint,
    invoer: {
      readonly boekjaarId: bigint;
      readonly periodeVan: string;
      readonly periodeTot: string;
      readonly factuurdatum: string;
      readonly vervaldatum: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ aantal: number; totaalCenten: number }>;
  /** Volledige notalijst van de VvE, optioneel alleen openstaand. */
  lijst(vveId: bigint, alleenOpen: boolean): Promise<readonly NotaRij[]>;
  /** Eén nota met haar specificatieregels (AC6.2). */
  detail(
    vveId: bigint,
    notaId: bigint,
  ): Promise<{
    readonly nota: NotaRij;
    readonly regels: readonly {
      readonly omschrijving: string;
      readonly bedragCent: number;
      readonly isReservefonds: boolean;
    }[];
  }>;
}

/**
 * De index van de gevraagde periode binnen het schema (0-basis): maanden
 * sinds de eerste januari van het schema-jaar. Het restcent van de §5.3-
 * verdeling valt in de eerste perioden; de index bepaalt wie hem krijgt.
 */
function periodeIndexVan(periodeVan: string): number {
  const jaar = Number(periodeVan.slice(0, 4));
  const maand = Number(periodeVan.slice(5, 7));
  return (jaar - jaar) * 12 + (maand - 1);
}
function periodeBedrag(jaarCenten: number, perioden: number, index: number): number {
  const delen = grootsteRestVerdeler.verdeel(
    Bedrag.vanCenten(jaarCenten),
    new Map(Array.from({ length: perioden }, (_, i) => [BigInt(i), 1] as const)),
  );
  return delen.get(BigInt(index))?.centen ?? 0;
}

export function maakNotaService(config: { readonly db: NodePgDatabase }): NotaService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async genereerPeriode(vveId, invoer, doorPersoonId) {
      for (const datum of [
        invoer.periodeVan,
        invoer.periodeTot,
        invoer.factuurdatum,
        invoer.vervaldatum,
      ]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
          throw new InvoerFout('Alle data moeten de vorm YYYY-MM-DD hebben.');
        }
      }
      if (invoer.vervaldatum <= invoer.factuurdatum) {
        throw new InvoerFout('De vervaldatum moet na de factuurdatum liggen.');
      }

      const { aantal, totaalCenten } = await inTenantTransactie(db, vveId, async (tx) => {
        // Het boekjaar moet bij deze VvE horen (en is de nummerreeks-anker).
        const [jaar] = await tx
          .select({ id: boekjaar.id, status: boekjaar.status })
          .from(boekjaar)
          .where(sql`${boekjaar.id} = ${invoer.boekjaarId} AND ${boekjaar.vveId} = ${vveId}`)
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        if (jaar.status !== 'open') {
          throw new InvoerFout('Nota-generatie kan alleen in een open boekjaar.');
        }

        // Het bijdrageschema van dit boekjaar moet er zijn en vastgesteld.
        const [schema] = await tx
          .select({
            id: bijdrageSchema.id,
            periodiciteit: bijdrageSchema.periodiciteit,
            status: bijdrageSchema.status,
            ingangsdatum: bijdrageSchema.ingangsdatum,
          })
          .from(bijdrageSchema)
          .where(
            sql`${bijdrageSchema.vveId} = ${vveId} AND ${bijdrageSchema.boekjaarId} = ${invoer.boekjaarId}`,
          )
          .limit(1);
        if (schema === undefined) {
          throw new InvoerFout('Er is geen bijdrageschema voor dit boekjaar.');
        }
        if (schema.status !== 'vastgesteld') {
          throw new InvoerFout('Nota-generatie eist een vastgesteld bijdrageschema (AC5.1).');
        }
        if (invoer.periodeVan < schema.ingangsdatum) {
          throw new InvoerFout('De periode begint vóór de ingangsdatum van het schema.');
        }

        // Nummerreeks (test #10, concurrency): de boekjaar-rij wordt met
        // FOR UPDATE vergrendeld — alle gelijktijdige generaties voor dit
        // boekjaar serialiseren op die rijvergrendeling, zodat telling én
        // idempotentie-toets op de stand van na de vorige COMMIT lezen.
        const [vergrendeld] = await tx
          .select({ id: boekjaar.id })
          .from(boekjaar)
          .where(sql`${boekjaar.id} = ${invoer.boekjaarId}`)
          .for('update');
        if (vergrendeld === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');

        // Idempotentie — ná de vergrendeling (anders lopen parallelle
        // generaties er allebei doorheen en ontstaan dubbele periode-nota's).
        const bestaan = await tx
          .select({ id: nota.id })
          .from(nota)
          .where(
            sql`${nota.vveId} = ${vveId} AND ${nota.boekjaarId} = ${invoer.boekjaarId} AND ${nota.type} = 'periodieke_bijdrage' AND ${nota.periodeVan} = ${invoer.periodeVan} AND ${nota.periodeTot} = ${invoer.periodeTot}`,
          )
          .limit(1);
        if (bestaan.length > 0) return { aantal: 0, totaalCenten: 0 };

        // Aantal perioden van het schema; index uit de periode-maand (0-basis).
        const perioden =
          schema.periodiciteit === 'kwartaal' ? 4 : schema.periodiciteit === 'jaar' ? 1 : 12;
        const periodeIndex = periodeIndexVan(invoer.periodeVan);
        if (periodeIndex < 0 || periodeIndex >= perioden) {
          throw new InvoerFout('De periode valt buiten het bijdrageschema.');
        }

        // Jaarbedragen per eenheid uit het schema.
        const regels = await tx
          .select({
            wooneenheidId: bijdrageRegel.wooneenheidId,
            exploitatieCent: bijdrageRegel.exploitatieCent,
            reservefondsCent: bijdrageRegel.reservefondsCent,
          })
          .from(bijdrageRegel)
          .where(sql`${bijdrageRegel.bijdrageSchemaId} = ${schema.id}`);
        if (regels.length === 0) {
          throw new InvoerFout('Het bijdrageschema heeft geen regels; herbereken eerst (G05).');
        }

        // De debiteur per eenheid: het primaire eigenaarschap op de
        // factuurdatum (§6.6). Zonder eigenaar op die datum: geen nota
        // (bewust, gerapporteerd in de uitkomst via de telling).
        const eigenaren = await tx
          .select({
            wooneenheidId: eigenaarschap.wooneenheidId,
            persoonId: eigenaarschap.persoonId,
            isPrimair: eigenaarschap.isPrimairContact,
          })
          .from(eigenaarschap)
          .where(sql`${eigenaarschap.periode} @> ${invoer.factuurdatum}::date`);

        // Nummerreeks: telling ná de vergrendeling boven; restcenten zijn
        // per component (exploitatie/reserve) berekend in periodeBedrag.
        const [telling] = await tx
          .select({ aantal: sql<number>`count(*)::int` })
          .from(nota)
          .where(sql`${nota.boekjaarId} = ${invoer.boekjaarId}`);
        let volgnr = telling?.aantal ?? 0;
        const jaarNummer = invoer.factuurdatum.slice(0, 4);

        let totaal = Bedrag.vanCenten(0);
        let gegenereerd = 0;
        for (const r of regels) {
          const exploitatie = periodeBedrag(r.exploitatieCent, perioden, periodeIndex);
          const reserve = periodeBedrag(r.reservefondsCent, perioden, periodeIndex);
          const bedrag = exploitatie + reserve;
          if (bedrag <= 0) continue;

          const eigenaar = eigenaren.find(
            (e) => e.wooneenheidId === r.wooneenheidId && e.isPrimair,
          );
          const debiteur =
            eigenaar?.persoonId ??
            eigenaren.find((e) => e.wooneenheidId === r.wooneenheidId)?.persoonId;
          if (debiteur === undefined) continue; // geen eigenaar op de factuurdatum

          volgnr += 1;
          const nummer = `${jaarNummer}-${String(volgnr).padStart(4, '0')}`;
          const [rij] = await tx
            .insert(nota)
            .values({
              vveId,
              wooneenheidId: r.wooneenheidId,
              persoonId: debiteur,
              boekjaarId: invoer.boekjaarId,
              nummer,
              type: 'periodieke_bijdrage',
              periodeVan: invoer.periodeVan,
              periodeTot: invoer.periodeTot,
              factuurdatum: invoer.factuurdatum,
              vervaldatum: invoer.vervaldatum,
              bedragCent: bedrag,
              openstaandCent: bedrag,
              betaalwijze: 'overboeking',
              betalingskenmerk: `NOTA${nummer}`,
              status: 'open',
            })
            .returning({ id: nota.id });
          if (rij === undefined) throw new Error('nota-insert leverde geen id op');
          totaal = totaal.plus(Bedrag.vanCenten(bedrag));
          gegenereerd += 1;

          // Vooruitbetaling (test #9, AC6.3): het creditsaldo van de eenheid
          // verrekent automatisch met de verse nota. De verrekening loopt als
          // betaling met bron 'verrekening' (§6.1) en koppeling — het
          // expliciete boekhoudkundige spoor, hier in dezelfde transactie.
          const [saldoRij] = await tx
            .select({ betaald: sql<number>`COALESCE(SUM(b.bedrag_cent), 0)::int` })
            .from(sql`betaling b`)
            .where(sql`b.vve_id = ${vveId} AND b.wooneenheid_id = ${r.wooneenheidId}`);
          const [gekoppeldRij] = await tx
            .select({ gekoppeld: sql<number>`COALESCE(SUM(k.bedrag_cent), 0)::int` })
            .from(sql`betaling_koppeling k JOIN betaling b ON b.id = k.betaling_id`)
            .where(sql`b.vve_id = ${vveId} AND b.wooneenheid_id = ${r.wooneenheidId}`);
          const saldo = (saldoRij?.betaald ?? 0) - (gekoppeldRij?.gekoppeld ?? 0);
          const verrekening = Math.min(saldo, bedrag);
          if (verrekening > 0) {
            const [betRij] = await tx
              .insert(betaling)
              .values({
                vveId,
                wooneenheidId: r.wooneenheidId,
                datum: invoer.factuurdatum,
                bedragCent: verrekening,
                bron: 'verrekening',
                omschrijving: `Automatische verwerking creditsaldo met nota ${nummer}`,
              })
              .returning({ id: betaling.id });
            if (betRij === undefined) throw new Error('verrekening-insert leverde geen id op');
            await tx.insert(betalingKoppeling).values({
              betalingId: betRij.id,
              notaId: rij.id,
              bedragCent: verrekening,
            });
            const nieuwOpenstaand = bedrag - verrekening;
            await tx
              .update(nota)
              .set({
                openstaandCent: nieuwOpenstaand,
                status: nieuwOpenstaand === 0 ? 'betaald' : 'deels_betaald',
              })
              .where(and(eq(nota.vveId, vveId), eq(nota.id, rij.id)));
          }
        }
        return { aantal: gegenereerd, totaalCenten: totaal.centen };
      });

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'nota.genereer_periode',
        categorie: 'financieel',
        onderwerpTabel: 'nota',
        onderwerpId: 0n,
        details: { periode: invoer.periodeVan, aantal, totaalCenten },
      });
      return { aantal, totaalCenten };
    },

    async lijst(vveId, alleenOpen) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const voorwaarde = alleenOpen
          ? sql`${nota.vveId} = ${vveId} AND ${nota.status} IN ('open', 'deels_betaald')`
          : sql`${nota.vveId} = ${vveId}`;
        return tx
          .select({
            id: nota.id,
            nummer: nota.nummer,
            eenheidCode: wooneenheid.code,
            periodeVan: nota.periodeVan,
            periodeTot: nota.periodeTot,
            factuurdatum: nota.factuurdatum,
            vervaldatum: nota.vervaldatum,
            bedragCent: nota.bedragCent,
            openstaandCent: nota.openstaandCent,
            betaalwijze: nota.betaalwijze,
            betalingskenmerk: nota.betalingskenmerk,
            status: nota.status,
          })
          .from(nota)
          .innerJoin(wooneenheid, eq(wooneenheid.id, nota.wooneenheidId))
          .where(voorwaarde)
          .orderBy(asc(nota.nummer));
      });
    },

    async detail(vveId, notaId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select()
          .from(nota)
          .where(sql`${nota.vveId} = ${vveId} AND ${nota.id} = ${notaId}`)
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Nota niet gevonden.');
        const regels = await tx
          .select({
            omschrijving: notaRegel.omschrijving,
            bedragCent: notaRegel.bedragCent,
            isReservefonds: notaRegel.isReservefonds,
          })
          .from(notaRegel)
          .where(sql`${notaRegel.notaId} = ${notaId}`);
        const [code] = await tx
          .select({ code: wooneenheid.code })
          .from(wooneenheid)
          .where(sql`${wooneenheid.id} = ${rij.wooneenheidId}`)
          .limit(1);
        return {
          nota: {
            id: rij.id,
            nummer: rij.nummer,
            eenheidCode: code?.code ?? '',
            periodeVan: rij.periodeVan,
            periodeTot: rij.periodeTot,
            factuurdatum: rij.factuurdatum,
            vervaldatum: rij.vervaldatum,
            bedragCent: rij.bedragCent,
            openstaandCent: rij.openstaandCent,
            betaalwijze: rij.betaalwijze,
            betalingskenmerk: rij.betalingskenmerk,
            status: rij.status,
          },
          regels,
        };
      });
    },
  };
}
