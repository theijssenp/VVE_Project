/**
 * Debiteuren-service — blok G09 (spec §6.6, M6 · AC6.4/AC6.8).
 *
 * **AC6.4 — Debiteurenoverzicht.** Per eenheid en per VvE de openstaande
 * nota's, gebucketd naar de vervaldatum: 0–30 / 31–60 / 61–90 / 90+ dagen
 * vervallen (vóór vandaag = ouderdom; nog-niet-vervallen = 'lopend'). De
 * som van de buckets == het totaal openstaand (invariant, getest).
 *
 * **AC6.8 — Dossier per debiteur.** Chronologisch: nota's, betalingen en
 * verrekeningen van één eenheid — exporteerbaar als PDF voor een
 * incassobureau. Toegangslogging (§8.3: "inzage in het debiteurendossier van
 * een ander lid wordt gelogd") gebeurt in de controller.
 *
 * Lees-only: dit blok schrijft niets — het is het venster op G06/G08.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { betaling } from '../database/schema/betaling.js';
import { nota } from '../database/schema/nota.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

/** De vier buckets van AC6.4, plus het nog-niet-vervallen restje. */
export interface OuderdomBucket {
  readonly dagen0Tot30: number;
  readonly dagen31Tot60: number;
  readonly dagen61Tot90: number;
  readonly dagen90Plus: number;
  readonly nogNietVervallen: number;
}

export interface EenhedenRij {
  readonly wooneenheidId: bigint;
  readonly code: string;
  readonly openstaandCenten: number;
  readonly oudsteVervaldatum: string | null;
}

export interface DossierRegel {
  readonly datum: string;
  readonly soort: 'nota' | 'betaling' | 'verrekening';
  readonly kenmerk: string;
  readonly bedragCent: number;
  readonly omschrijving: string | null;
}

export interface DebiteurenService {
  /** AC6.4: ouderdomsanalyse per VvE, som per bucket. */
  ouderdomsanalyse(
    vveId: bigint,
    peildatum?: string,
  ): Promise<OuderdomBucket & { totaalCenten: number }>;
  /** AC6.4: openstaand per eenheid, voor het per-eenheid-overzicht. */
  perEenheid(vveId: bigint, peildatum?: string): Promise<readonly EenhedenRij[]>;
  /** AC6.8: het chronologische dossier van één eenheid (nota's + betalingen). */
  dossier(
    vveId: bigint,
    wooneenheidId: bigint,
    doorPersoonId: bigint,
  ): Promise<{
    readonly eenheidCode: string;
    readonly regels: readonly {
      readonly datum: string;
      readonly soort: 'nota' | 'betaling' | 'verrekening';
      readonly kenmerk: string;
      readonly bedragCent: number;
      readonly omschrijving: string | null;
    }[];
    readonly openstaandTotaalCenten: number;
  }>;
}

export function maakDebiteurenService(config: {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
}): DebiteurenService {
  const { db, klok } = config;
  const audit = maakAuditService({ db });

  return {
    async ouderdomsanalyse(vveId, peildatum) {
      const vandaag = peildatum ?? klok.nu().toISOString().slice(0, 10);
      return inTenantTransactie(db, vveId, async (tx) => {
        // De buckets lopen over de vervaldatum tegen de peildatum; alleen
        // open/deels_betaald telt mee (betaald/gecrediteerd/oninbaar niet).
        // De peildatum als date; interval-rekenkunde via `::date - interval`.
        const [rij] = await tx
          .select({
            dag0: sql<number>`COALESCE(SUM(CASE WHEN ${nota.vervaldatum} >= (${vandaag}::date - INTERVAL '29 days') AND ${nota.vervaldatum} <= ${vandaag}::date THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            dag31: sql<number>`COALESCE(SUM(CASE WHEN ${nota.vervaldatum} >= (${vandaag}::date - INTERVAL '60 days') AND ${nota.vervaldatum} <= (${vandaag}::date - INTERVAL '31 days') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            dag61: sql<number>`COALESCE(SUM(CASE WHEN ${nota.vervaldatum} >= (${vandaag}::date - INTERVAL '90 days') AND ${nota.vervaldatum} <= (${vandaag}::date - INTERVAL '61 days') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            dag90: sql<number>`COALESCE(SUM(CASE WHEN ${nota.vervaldatum} <= (${vandaag}::date - INTERVAL '91 days') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            nietVervallen: sql<number>`COALESCE(SUM(CASE WHEN ${nota.vervaldatum} > ${vandaag}::date THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            totaal: sql<number>`COALESCE(SUM(${nota.openstaandCent}), 0)::int`,
          })
          .from(nota)
          .where(sql`${nota.vveId} = ${vveId} AND ${nota.status} IN ('open', 'deels_betaald')`);
        return {
          dagen0Tot30: rij?.dag0 ?? 0,
          dagen31Tot60: rij?.dag31 ?? 0,
          dagen61Tot90: rij?.dag61 ?? 0,
          dagen90Plus: rij?.dag90 ?? 0,
          nogNietVervallen: rij?.nietVervallen ?? 0,
          totaalCenten: rij?.totaal ?? 0,
        };
      });
    },

    async perEenheid(vveId, peildatum) {
      // De oudste vervaldatum is al de sorteersleutel; peildatum volgt in G11.
      if (peildatum !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(peildatum)) {
        throw new InvoerFout('Peildatum moet de vorm YYYY-MM-DD hebben.');
      }
      return inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            wooneenheidId: wooneenheid.id,
            code: wooneenheid.code,
            openstaandCenten: sql<number>`COALESCE(SUM(CASE WHEN ${nota.status} IN ('open', 'deels_betaald') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            oudsteVervaldatum: sql<
              string | null
            >`MIN(CASE WHEN ${nota.status} IN ('open', 'deels_betaald') THEN ${nota.vervaldatum} END)`,
          })
          .from(wooneenheid)
          .leftJoin(nota, eq(nota.wooneenheidId, wooneenheid.id))
          .where(eq(wooneenheid.vveId, vveId))
          .groupBy(wooneenheid.id, wooneenheid.code)
          .orderBy(wooneenheid.code),
      );
    },

    async dossier(vveId, wooneenheidId, doorPersoonId) {
      const { regels, eenheidCode, openstaandTotaalCenten } = await inTenantTransactie(
        db,
        vveId,
        async (tx) => {
          const [eenheidRij] = await tx
            .select({ code: wooneenheid.code })
            .from(wooneenheid)
            .where(and(eq(wooneenheid.vveId, vveId), eq(wooneenheid.id, wooneenheidId)))
            .limit(1);
          if (eenheidRij === undefined) {
            throw new NietGevondenFout('Eenheid niet gevonden in deze VvE.');
          }

          // Nota's van de eenheid (chronologisch op factuurdatum).
          const notarijen = await tx
            .select({
              datum: nota.factuurdatum,
              nummer: nota.nummer,
              type: nota.type,
              status: nota.status,
              bedragCent: nota.bedragCent,
              openstaandCent: nota.openstaandCent,
            })
            .from(nota)
            .where(and(eq(nota.vveId, vveId), eq(nota.wooneenheidId, wooneenheidId)))
            .orderBy(nota.factuurdatum);

          // Betalingen (gekoppeld en verrekeningen) van de eenheid.
          const betalingRijen = await tx
            .select({
              datum: betaling.datum,
              bron: betaling.bron,
              bedragCent: betaling.bedragCent,
              omschrijving: betaling.omschrijving,
            })
            .from(betaling)
            .where(and(eq(betaling.vveId, vveId), eq(betaling.wooneenheidId, wooneenheidId)))
            .orderBy(betaling.datum);

          // Samenvoegen chronologisch; soort uit de bron.
          const regels = [
            ...notarijen.map((n) => ({
              datum: n.datum,
              soort: 'nota' as const,
              kenmerk: n.nummer,
              bedragCent: n.bedragCent,
              omschrijving: `${n.type} (${n.status})`,
            })),
            ...betalingRijen.map((b) => ({
              datum: b.datum,
              soort: b.bron === 'verrekening' ? ('verrekening' as const) : ('betaling' as const),
              kenmerk: b.bron,
              bedragCent: b.bedragCent,
              omschrijving: b.omschrijving,
            })),
          ].sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));

          const [totaalRij] = await tx
            .select({
              totaal: sql<number>`COALESCE(SUM(CASE WHEN ${nota.status} IN ('open', 'deels_betaald') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
            })
            .from(nota)
            .where(and(eq(nota.vveId, vveId), eq(nota.wooneenheidId, wooneenheidId)));

          return {
            regels,
            eenheidCode: eenheidRij.code,
            openstaandTotaalCenten: totaalRij?.totaal ?? 0,
          };
        },
      );

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'debiteuren.dossier_ingezien',
        categorie: 'financieel',
        onderwerpTabel: 'wooneenheid',
        onderwerpId: wooneenheidId,
        details: { eenheidCode, regels: regels.length },
      });
      return { eenheidCode, regels, openstaandTotaalCenten };
    },
  };
}
