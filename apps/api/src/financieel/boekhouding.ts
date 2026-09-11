/**
 * De boekingsservice — blok G02 (spec §7.4, §6.7 · tests #20–#21).
 *
 * Het enige pad naar `boeking` en `boekingsregel`. Twee vangnetten op de
 * balanseis (§7.4: "beide moeten bestaan"):
 *   1. deze service weigert vóór het schrijven (OnbalansFout), en
 *   2. de deferred constraint trigger uit migratie 0014 controleert de som
 *      per boeking bij COMMIT — het vangnet voor alles dat buiten de service
 *      om geprobeerd wordt.
 *
 * **Append-only (§7.4):** boekingen worden nooit gemuteerd; een fout wordt
 * gecorrigeerd met een tegenboeking. De applicatierol heeft daarom geen
 * UPDATE/DELETE (migratie 0014). `vergrendeld` zet uitsluitend de
 * jaarafsluiting (B10) via een eigen, expliciet gerechtigde routine.
 *
 * **Nummering:** per boekjaar oplopend, formaat `2026-000001`, atomair
 * verhoogd met `count(*)` binnen de tenant-transactie (één gebruiker per
 * VvE; een race tussen twee gelijktijdige boekingen is hier reëel, maar de
 * UNIQUE (vve_id, nummer) vangt de rest af en de transactie herprobeert
 * niet — bij gelijktijdigheid slaagt er één en faalt de andere hoorbaar).
 */

import { and, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag } from '@vve/domein';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { boeking, boekingsregel } from '../database/schema/boeking.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { grootboekrekening } from '../database/schema/grootboekrekening.js';

export class OnbalansFout extends Error {
  constructor() {
    super('Boeking is niet in balans: som debet <> som credit.');
    this.name = 'OnbalansFout';
  }
}

export class InvoerFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'InvoerFout';
  }
}

export class NietGevondenFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'NietGevondenFout';
  }
}

/** Één regel van een journaalpost: debet óf credit, nooit beide, nooit allebei nul. */
export interface Regel {
  readonly rekeningNummer: string;
  readonly bedrag: Bedrag;
  readonly kant: 'debet' | 'credit';
  readonly wooneenheidId?: bigint | null;
  readonly omschrijving?: string | null;
}

export const Regel = {
  debet(
    rekeningNummer: string,
    bedrag: Bedrag,
    opties: { wooneenheidId?: bigint | null; omschrijving?: string | null } = {},
  ): Regel {
    return { rekeningNummer, bedrag, kant: 'debet', ...opties };
  },
  credit(
    rekeningNummer: string,
    bedrag: Bedrag,
    opties: { wooneenheidId?: bigint | null; omschrijving?: string | null } = {},
  ): Regel {
    return { rekeningNummer, bedrag, kant: 'credit', ...opties };
  },
} as const;

export interface BoekVerzoek {
  readonly datum: string; // YYYY-MM-DD — kalenderdatum, nooit tz-conversie
  readonly omschrijving: string;
  readonly bron:
    'nota' | 'betaling' | 'bank' | 'incasso' | 'memoriaal' | 'openingsbalans' | 'jaarafsluiting';
  readonly bronId?: bigint | null;
  readonly regels: readonly Regel[];
}

export interface BoekUitkomst {
  readonly boekingId: bigint;
  readonly nummer: string;
}

/** Het transactie-object dat `db.transaction` doorgeeft (zelfde vorm als in tenant-context). */
type TenantTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface Boekhouding {
  /**
   * Boekt één journaalpost binnen de tenant-transactie. Werpt OnbalansFout
   * als debet ≠ credit; de deferred trigger vangt af wat buiten de service
   * om geprobeerd wordt.
   */
  boek(
    vveId: bigint,
    boekjaarId: bigint,
    verzoek: BoekVerzoek,
    doorPersoonId: bigint,
  ): Promise<BoekUitkomst>;
}

/**
 * De boekingsservice. De `tx` die de aanroeper al binnen een
 * tenant-transactie heeft wordt aanvaard (de aanroeper bepaalt de tenant);
 * zonder eigen transactie-aanroep — de service schrijft altijd in de
 * transactie van zijn beller, zodat nota+bijbehorende boeking atomair zijn.
 */
export function maakBoekhouding(config: { readonly db: NodePgDatabase }): Boekhouding {
  const { db } = config;

  /** Zoekt rekening-id's per nummer binnen de tenant; onbekend → InvoerFout. */
  async function rekeningMap(
    tx: TenantTx,
    vveId: bigint,
    nummers: readonly string[],
  ): Promise<Map<string, bigint>> {
    const uniek = [...new Set(nummers)];
    const rijen = await tx
      .select({ id: grootboekrekening.id, nummer: grootboekrekening.nummer })
      .from(grootboekrekening)
      .where(sql`${grootboekrekening.vveId} = ${vveId}`);
    const map = new Map(rijen.map((r) => [r.nummer, r.id]));
    for (const n of uniek) {
      if (!map.has(n)) {
        throw new InvoerFout(`Grootboekrekening ${n} bestaat niet in deze VvE.`);
      }
    }
    return map;
  }

  return {
    async boek(vveId, boekjaarId, verzoek, doorPersoonId) {
      // Validatie vóór de transactie (goedkope fouten eerst).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(verzoek.datum)) {
        throw new InvoerFout('De boekdatum moet de vorm YYYY-MM-DD hebben.');
      }
      if (verzoek.regels.length === 0) {
        throw new InvoerFout('Een boeking heeft ten minste één regel.');
      }
      for (const r of verzoek.regels) {
        if (r.bedrag.centen <= 0) {
          throw new InvoerFout('Een boekingregel moet een positief bedrag hebben.');
        }
      }
      const debet = verzoek.regels
        .filter((r) => r.kant === 'debet')
        .reduce((s, r) => s + r.bedrag.centen, 0);
      const credit = verzoek.regels
        .filter((r) => r.kant === 'credit')
        .reduce((s, r) => s + r.bedrag.centen, 0);
      if (debet !== credit) {
        throw new OnbalansFout();
      }

      return inTenantTransactie(db, vveId, async (tx) => {
        // Het boekjaar moet van deze VvE zijn en in balans-status "open" —
        // boeken in een concept- of afgesloten jaar is een invoerfout (AC9.3:
        // afsluiten vergrendelt).
        const [jaar] = await tx
          .select({
            id: boekjaar.id,
            status: boekjaar.status,
            startDatum: boekjaar.startDatum,
            eindDatum: boekjaar.eindDatum,
          })
          .from(boekjaar)
          .where(and(sql`${boekjaar.vveId} = ${vveId}`, sql`${boekjaar.id} = ${boekjaarId}`))
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        if (jaar.status !== 'open') {
          throw new InvoerFout('Boeken kan alleen in een open boekjaar.');
        }
        if (verzoek.datum < jaar.startDatum || verzoek.datum > jaar.eindDatum) {
          throw new InvoerFout('De boekdatum valt buiten het boekjaar.');
        }

        // Boekjaar-nummer: per jaar oplopend, atoom binnen de transactie.
        const [telling] = await tx
          .select({ aantal: sql<number>`count(*)::int` })
          .from(boeking)
          .where(sql`${boeking.boekjaarId} = ${boekjaarId}`);
        const volgnr = (telling?.aantal ?? 0) + 1;
        const nummer = `${jaar.startDatum.slice(0, 4)}-${String(volgnr).padStart(6, '0')}`;

        // Rekeningnummers → id's (binnen de tenant; RLS beschermt de map).
        const rekeningen = await rekeningMap(
          tx,
          vveId,
          verzoek.regels.map((r) => r.rekeningNummer),
        );

        const [rij] = await tx
          .insert(boeking)
          .values({
            vveId,
            boekjaarId,
            nummer,
            datum: verzoek.datum,
            omschrijving: verzoek.omschrijving,
            bron: verzoek.bron,
            bronId: verzoek.bronId ?? null,
            aangemaaktDoor: doorPersoonId,
          })
          .returning({ id: boeking.id });
        if (rij === undefined) throw new Error('boeking-insert leverde geen id op');

        await tx.insert(boekingsregel).values(
          verzoek.regels.map((r) => ({
            boekingId: rij.id,
            grootboekrekeningId: rekeningen.get(r.rekeningNummer) ?? 0n,
            wooneenheidId: r.wooneenheidId ?? null,
            omschrijving: r.omschrijving ?? null,
            debetCent: r.kant === 'debet' ? r.bedrag.centen : 0,
            creditCent: r.kant === 'credit' ? r.bedrag.centen : 0,
          })),
        );
        // De deferred trigger uit migratie 0014 controleert bij COMMIT dat
        // deze boeking in balans is; de service heeft hem hierboven al
        // zelf gewogen (OnbalansFout). Twee bewakers, één eis (§7.4).
        return { boekingId: rij.id, nummer };
      });
    },
  };
}
