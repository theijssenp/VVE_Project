/**
 * Eigenaarschap-service — blok V03 (spec §6.4, M2 · AC2.4/AC2.5, test 34).
 *
 * **AC2.4:** meerdere eigenaren per eenheid, met een aandeel per eigenaar
 * (promille, default 1000 bij een solitair eigenaarschap) en één primair
 * contact. De EXCLUDE-constraints uit migratie 0010 bewaken op de database:
 *   - `geen_dubbel_volledig_eigendom`: twee keer volledig (1000) op dezelfde
 *     eenheid in dezelfde periode is onmogelijk (test #34);
 *   - `eigenaarschap_per_uniek_per_persoon`: dezelfde persoon staat niet
 *     twee keer op dezelfde eenheid in overlappende periodes.
 * De som-toets (twee keer 600 wordt geweigerd, 500/500 toegestaan) is
 * domeinlogica en zit in deze service; de constraint kan haar niet dragen
 * (een EXCLUDE op een SUM bestaat niet).
 *
 * **AC2.5:** de eigenaarswissel op een leveringsdatum — het oude
 * eigenaarschap eindigt op leveringsdatum − 1, het nieuwe begint op de
 * leveringsdatum, in één transactie. Historische nota's/betalingen blijven
 * aan de oude eigenaar. Het verrekenoverzicht verdeelt de bijdrage van het
 * leveringsjaar naar rato over de dagen van oud en nieuw (AC9.6-geest), met
 * `verdeelGrootsteRest` (spec §5.2) zodat de som van de rijen exact gelijk
 * is aan het jaartotaal.
 *
 * **§8.3-aantekening:** het dossier-overzicht van de *andere* eigenaar
 * logging de controller.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { verdeelGrootsteRest } from '@vve/domein';

import { eigenaarschap } from '../database/schema/eigenaarschap.js';
import { nota } from '../database/schema/nota.js';
import { persoon } from '../database/schema/persoon.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export interface EigenaarRij {
  readonly eigenaarschapId: bigint;
  readonly persoonId: bigint;
  readonly achternaam: string;
  readonly email: string;
  readonly aandeelPromille: number;
  readonly isPrimairContact: boolean;
  readonly vanaf: string;
  readonly totEnMet: string | null;
}

export interface VerrekeningRij {
  readonly persoonId: bigint;
  readonly achternaam: string;
  readonly dagenInJaar: number;
  readonly aandeelPromille: number;
  readonly teBetalenCenten: number;
}

export interface EigenaarschapService {
  /** Voegt een (tweede) eigenaar toe met aandeel en primair-contact-vlag. */
  voegEigenaarToe(
    vveId: bigint,
    wooneenheidId: bigint,
    invoer: {
      persoonId: bigint;
      aandeelPromille?: number;
      isPrimairContact: boolean;
      vanaf?: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  /** Zet het primaire contact over naar een andere eigenaar (AC2.4). */
  zetPrimairContact(
    vveId: bigint,
    wooneenheidId: bigint,
    eigenaarschapId: bigint,
    doorPersoonId: bigint,
  ): Promise<void>;
  /** AC2.5: de eigenaarswissel op de leveringsdatum, in één transactie. */
  wisselEigenaar(
    vveId: bigint,
    wooneenheidId: bigint,
    invoer: {
      nieuwePersoonId: bigint;
      leveringsdatum: string;
      aandeelPromille?: number;
    },
    doorPersoonId: bigint,
  ): Promise<{ oudId: bigint; nieuwId: bigint }>;
  /** AC2.5/AC9.6: verrekenoverzicht naar rato over de dagen van het jaar. */
  verrekenOverzicht(
    vveId: bigint,
    wooneenheidId: bigint,
    leveringsdatum: string,
  ): Promise<{
    readonly eenheidCode: string;
    readonly jaar: number;
    readonly rijen: readonly VerrekeningRij[];
    readonly totaalCenten: number;
    readonly openstaandePostenOudeEigenaarCenten: number;
  }>;
  /** De eigenaren van een eenheid (huidig en historie). */
  eigenaren(vveId: bigint, wooneenheidId: bigint): Promise<readonly EigenaarRij[]>;
}

export function maakEigenaarschapService(config: {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
}): EigenaarschapService {
  const { db, klok } = config;
  const audit = maakAuditService({ db });

  /** Kalenderdatum-validatie; geeft de string terug. */
  function kalenderdatum(waarde: unknown, veld: string): string {
    if (typeof waarde !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(waarde)) {
      throw new InvoerFout(`Veld "${veld}" moet de vorm YYYY-MM-DD hebben.`);
    }
    return waarde;
  }

  /** Parseert de start van een Postgres-daterange-tekst '[2026-01-01,...'. */
  function periodeStart(periode: string): string {
    return periode.substring(1, 11);
  }

  /**
  /**
   * Parseert de eindscheiding van een daterange-tekst. `[a,b)` heeft 'a,b' als
   * middendeel; `[a,)` (open) heeft daar een lege rechterzijde. De oude parse
   * (`includes(')')`) behandelde élke half-open range als open en verloor zo
   * de einddatum van juist de historische rijen.
   */
  function periodeEind(periode: string): string | null {
    const middendeel = periode.slice(1, -1).split(',')[1] ?? '';
    return middendeel.length === 10 ? middendeel : null;
  }

  return {
    async voegEigenaarToe(vveId, wooneenheidId, invoer, doorPersoonId) {
      const aandeel = invoer.aandeelPromille ?? 1000;
      if (!Number.isInteger(aandeel) || aandeel <= 0 || aandeel > 1000) {
        throw new InvoerFout('Het aandeel moet tussen 1 en 1000 promille liggen.');
      }
      const vanaf = invoer.vanaf ?? kalenderdatumVan(klok);
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        // Aandelen-overlap: de som in het nieuwe venster mag niet boven 1000
        // komen (AC2.4; de EXCLUDE-constraints bewaken dit niet — een
        // aggregaat constraint bestaat niet).
        const [som] = await tx
          .select({
            huidig: sql<number>`COALESCE(SUM(${eigenaarschap.aandeelPromille}), 0)::int`,
          })
          .from(eigenaarschap)
          .where(
            sql`${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} @> ${vanaf}::date`,
          );
        if ((som?.huidig ?? 0) + aandeel > 1000) {
          throw new InvoerFout(
            `De som van de aandelen komt op ${String((som?.huidig ?? 0) + aandeel)} promille; maximaal 1000.`,
          );
        }
        // Primair contact: als deze de eerste is, automatisch primair.
        const tellend = await tx
          .select({ id: eigenaarschap.id })
          .from(eigenaarschap)
          .where(
            sql`${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} @> ${vanaf}::date`,
          )
          .limit(1);
        const primair = tellend.length === 0;
        const [rij] = await tx
          .insert(eigenaarschap)
          .values({
            vveId,
            wooneenheidId,
            persoonId: invoer.persoonId,
            aandeelPromille: aandeel,
            isPrimairContact: primair,
            periode: `[${vanaf},)`,
          })
          .returning({ id: eigenaarschap.id })
          .catch((fout: unknown) => {
            const code = pgFoutcode(fout);
            if (code === '23P01' || code === '23505') {
              throw new InvoerFout('Deze persoon is al eigenaar van deze eenheid in deze periode.');
            }
            throw fout;
          });
        if (rij === undefined) throw new Error('eigenaarschap-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'eigenaarschap.toegevoegd',
        categorie: 'app',
        onderwerpTabel: 'eigenaarschap',
        onderwerpId: id,
        details: { wooneenheidId: String(wooneenheidId), aandeel },
      });
      return { id };
    },

    async zetPrimairContact(vveId, wooneenheidId, eigenaarschapId, doorPersoonId) {
      await inTenantTransactie(db, vveId, async (tx) => {
        const [doel] = await tx
          .select({ id: eigenaarschap.id })
          .from(eigenaarschap)
          .where(
            and(
              eq(eigenaarschap.vveId, vveId),
              eq(eigenaarschap.wooneenheidId, wooneenheidId),
              eq(eigenaarschap.id, eigenaarschapId),
            ),
          )
          .limit(1);
        if (doel === undefined) throw new NietGevondenFout('Eigenaarschap niet gevonden.');
        // Eerst iedereen in het huidige venster af, dan het doel aan.
        await tx
          .update(eigenaarschap)
          .set({ isPrimairContact: false })
          .where(
            sql`${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} @> ${kalenderdatumVan(klok)}::date`,
          );
        await tx
          .update(eigenaarschap)
          .set({ isPrimairContact: true })
          .where(eq(eigenaarschap.id, doel.id));
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'eigenaarschap.primair_contact_gewijzigd',
        categorie: 'app',
        onderwerpTabel: 'eigenaarschap',
        onderwerpId: eigenaarschapId,
        details: {},
      });
    },

    async wisselEigenaar(vveId, wooneenheidId, invoer, doorPersoonId) {
      const leveringsdatum = kalenderdatum(invoer.leveringsdatum, 'leveringsdatum');
      if (leveringsdatum < kalenderdatumVan(klok)) {
        throw new InvoerFout('De leveringsdatum mag niet in het verleden liggen.');
      }
      const dagErvoor = dagErvoorVan(leveringsdatum);

      const { oudId, nieuwId } = await inTenantTransactie(db, vveId, async (tx) => {
        // De lopende eigenaren op de dag vóór levering — zij eindigen.
        const huidige = await tx
          .select({
            id: eigenaarschap.id,
            persoonId: eigenaarschap.persoonId,
            aandeel: eigenaarschap.aandeelPromille,
            primair: eigenaarschap.isPrimairContact,
            periode: eigenaarschap.periode,
          })
          .from(eigenaarschap)
          .where(
            sql`${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} @> ${dagErvoor}::date`,
          )
          .for('update', { of: eigenaarschap });
        if (huidige.length === 0) {
          throw new NietGevondenFout('De eenheid heeft geen lopend eigenaarschap.');
        }
        if (huidige.some((h) => h.persoonId === invoer.nieuwePersoonId)) {
          throw new InvoerFout('De nieuwe eigenaar is al (mede)eigenaar van deze eenheid.');
        }
        // Primair contact bepaalt de "verkoper" voor het verrekenoverzicht;
        // zonder primair-vlag de eerste lopende rij.
        const oud = huidige.find((h) => h.primair) ?? huidige[0];
        if (oud === undefined) throw new NietGevondenFout('Geen primair eigenaarschap.');

        // AC2.5: oud eindigt op leveringsdatum − 1 (daterange: [start, levering)).
        // Als de wissel óp de leveringsdag wordt uitgevoerd is dat [oudStart,
        // levering) — de eindscheiding is exclusief, dus leveringsdatum − 1
        // is de laatste dag van de oude eigenaar.
        await tx
          .update(eigenaarschap)
          .set({ periode: `[${periodeStart(oud.periode)},${leveringsdatum})` })
          .where(eq(eigenaarschap.id, oud.id));

        // AC2.4: het aandeel van de nieuwe eigenaar; de oude had er soms meerdere.
        const aandeelNieuw = invoer.aandeelPromille ?? oud.aandeel;
        const [nieuwRij] = await tx
          .insert(eigenaarschap)
          .values({
            vveId,
            wooneenheidId,
            persoonId: invoer.nieuwePersoonId,
            aandeelPromille: aandeelNieuw,
            // AC2.5: het primaire contact gaat mee naar de nieuwe eigenaar.
            isPrimairContact: oud.primair,
            periode: `[${leveringsdatum},)`,
          })
          .returning({ id: eigenaarschap.id })
          .catch((fout: unknown) => {
            const code = pgFoutcode(fout);
            if (code === '23P01' || code === '23505') {
              throw new InvoerFout('Deze persoon is al eigenaar van deze eenheid in deze periode.');
            }
            throw fout;
          });
        if (nieuwRij === undefined) throw new Error('eigenaarschap-insert leverde geen id op');

        // Andere (niet-primaire) lopende eigenaren (mede-eigenaren) blijven
        // doorlopen — hun periode wordt niet aangepast; zij eindigen op hun
        // eigen moment. AC2.4 blijft daarmee intact.
        return { oudId: oud.id, nieuwId: nieuwRij.id };
      });

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'eigenaarswissel.uitgevoerd',
        categorie: 'app',
        onderwerpTabel: 'eigenaarschap',
        onderwerpId: oudId,
        details: { wooneenheidId: String(wooneenheidId), leveringsdatum },
      });
      return { oudId, nieuwId };
    },

    async verrekenOverzicht(vveId, wooneenheidId, leveringsdatum) {
      const jaar = Number(leveringsdatum.slice(0, 4));
      const jaarS = String(jaar);
      const jaarStart = `${jaarS}-01-01`;
      const jaarEind = `${String(jaar + 1)}-01-01`;

      const { eenheidCode, notaCenten } = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({ code: wooneenheid.code })
          .from(wooneenheid)
          .where(and(eq(wooneenheid.vveId, vveId), eq(wooneenheid.id, wooneenheidId)))
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Eenheid niet gevonden.');

        // De nota's in het leveringsjaar (historie blijft gekoppeld; AC2.5).
        const notarijen = await tx
          .select({ bedragCent: nota.bedragCent })
          .from(nota)
          .where(
            sql`${nota.vveId} = ${vveId} AND ${nota.wooneenheidId} = ${wooneenheidId} AND ${nota.factuurdatum} >= ${jaarStart} AND ${nota.factuurdatum} < ${jaarEind}`,
          );
        let totaal = 0;
        for (const n of notarijen) totaal += n.bedragCent;
        return { eenheidCode: rij.code, notaCenten: totaal };
      });

      // Rijen naar rato (AC9.6): per eigenaarsperiode de dagen in het jaar,
      // het aandeel en het naar-rato-aandeel van het jaartotaal — de som van
      // de rijbedragen is exact het jaartotaal (verdeelGrootsteRest, spec §5.2).
      const rijen = await inTenantTransactie(db, vveId, async (tx) => {
        const eigenaren = await tx
          .select({
            persoonId: eigenaarschap.persoonId,
            achternaam: persoon.achternaam,
            aandeel: eigenaarschap.aandeelPromille,
            periode: eigenaarschap.periode,
          })
          .from(eigenaarschap)
          .innerJoin(persoon, eq(persoon.id, eigenaarschap.persoonId))
          .where(
            sql`${eigenaarschap.vveId} = ${vveId} AND ${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} && daterange(${jaarStart}, ${jaarEind}, '[)')`,
          )
          .orderBy(eigenaarschap.persoonId, eigenaarschap.id);

        // Per rij de dagen in het leveringsjaar binnen de periode.
        const metDagen = eigenaren.map((e) => {
          const vanaf = periodeStart(e.periode);
          const tot = periodeEind(e.periode);
          const begin = vanaf > jaarStart ? vanaf : jaarStart;
          const eind = tot !== null && tot < jaarEind ? tot : jaarEind;
          const dagen = Math.max(
            0,
            Math.round(
              (Date.parse(`${eind}T00:00:00Z`) - Date.parse(`${begin}T00:00:00Z`)) / 86_400_000,
            ),
          );
          return { ...e, dagen };
        });

        // Gewichten: dagen × aandeel. Restcenten gaan via de grootste-rest-
        // methode naar de rijen met de grootste fractionele rest.
        const delen = verdeelGrootsteRest(
          notaCenten,
          metDagen.map((r) => Math.max(1, r.dagen * r.aandeel)),
        );

        return metDagen.map((r, index) => ({
          persoonId: r.persoonId,
          achternaam: r.achternaam,
          dagenInJaar: r.dagen,
          aandeelPromille: r.aandeel,
          teBetalenCenten: delen[index] ?? 0,
        }));
      });

      // Openstaande posten van de oude eigenaar (AC2.5-tail): de nota's die
      // op de leveringsdatum nog open/deels_betaald waren, gekoppeld aan de
      // eigenaar die op de dag vóór de levering het primaire contact was.
      const openstaand = await inTenantTransactie(db, vveId, async (tx) => {
        const [primair] = await tx
          .select({ persoonId: eigenaarschap.persoonId })
          .from(eigenaarschap)
          .where(
            sql`${eigenaarschap.wooneenheidId} = ${wooneenheidId} AND ${eigenaarschap.periode} @> ${dagErvoorVan(leveringsdatum)}::date AND ${eigenaarschap.isPrimairContact}`,
          )
          .limit(1);
        if (primair === undefined) return 0;
        const [som] = await tx
          .select({
            totaal: sql<number>`COALESCE(SUM(${nota.openstaandCent}), 0)::int`,
          })
          .from(nota)
          .where(
            sql`${nota.vveId} = ${vveId} AND ${nota.wooneenheidId} = ${wooneenheidId} AND ${nota.persoonId} = ${primair.persoonId} AND ${nota.status} IN ('open', 'deels_betaald')`,
          );
        return som?.totaal ?? 0;
      });

      return {
        eenheidCode,
        jaar,
        rijen,
        totaalCenten: notaCenten,
        openstaandePostenOudeEigenaarCenten: openstaand,
      };
    },

    async eigenaren(vveId, wooneenheidId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            eigenaarschapId: eigenaarschap.id,
            persoonId: eigenaarschap.persoonId,
            achternaam: persoon.achternaam,
            email: persoon.email,
            aandeel: eigenaarschap.aandeelPromille,
            primair: eigenaarschap.isPrimairContact,
            periode: eigenaarschap.periode,
          })
          .from(eigenaarschap)
          .innerJoin(persoon, eq(persoon.id, eigenaarschap.persoonId))
          .where(
            and(eq(eigenaarschap.vveId, vveId), eq(eigenaarschap.wooneenheidId, wooneenheidId)),
          )
          .orderBy(eigenaarschap.persoonId, eigenaarschap.id);
        return rijen.map((r) => ({
          eigenaarschapId: r.eigenaarschapId,
          persoonId: r.persoonId,
          achternaam: r.achternaam,
          email: r.email,
          aandeelPromille: r.aandeel,
          isPrimairContact: r.primair,
          vanaf: periodeStart(r.periode),
          // Weergave: de laatste dag inclusief (bovengrens − 1), null bij een
          // open range — de caller ziet "tot en met", niet de exclusieve grens.
          totEnMet:
            periodeEind(r.periode) === null ? null : dagErvoorVan(periodeEind(r.periode) as string),
        }));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Hulpfuncties (buiten de service-fabriek: zonder state)
// ---------------------------------------------------------------------------

/** De kalenderdag van vandaag volgens de geïnjecteerde klok (Europe/Amsterdam). */
function kalenderdatumVan(klok: Klok): string {
  const dag = klok.vandaag();
  const maand = String(dag.maand).padStart(2, '0');
  const dagS = String(dag.dag).padStart(2, '0');
  return `${String(dag.jaar)}-${maand}-${dagS}`;
}

/** De kalenderdag vóór de opgegeven datum (UTC-rekenkunde, kalendergetrouw). */
function dagErvoorVan(datum: string): string {
  const moment = new Date(`${datum}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() - 1);
  return moment.toISOString().slice(0, 10);
}

/**
 * Loopt de Drizzle/pg-foutketen naar beneden tot een bekende pg-foutcode;
 * Drizzle wikkelt driverfouten in een DrizzleQueryError met de oorspronkelijke
 * pg-fout op `cause` (patroon `isUniekConflict` uit eenheden.service.ts).
 */
function pgFoutcode(fout: unknown): string | undefined {
  if (typeof fout !== 'object' || fout === null) return undefined;
  const kandidaat = fout as { code?: unknown; cause?: unknown };
  if (typeof kandidaat.code === 'string') return kandidaat.code;
  return pgFoutcode(kandidaat.cause);
}
