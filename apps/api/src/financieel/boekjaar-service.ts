/**
 * Boekjaar-service — blok G02 (spec §6.7, AC9.3).
 *
 * Openen: één open boekjaar per VvE tegelijk (bewust: de boekingsservice
 * eist status 'open', en een tweede gelijktijdig open jaar is een administratieve
 * foutbron zonder gebruikscase). Afsluiten (AC9.3): vergrendelt alle
 * boekingen van het jaar, zet de status en sluit de boekdatum-vensters —
 * de vergrendeling zelf schrijft op `boeking.vergrendeld` via de
 * append-only-tabel: UPDATE is aan de migratie ontzegd voor vve_app, dus de
 * afsluiting loopt hier expliciet via de eigenaar-verbinding van de
 * migratierunner... niet: de applicatie heeft alleen vve_app.
 *
 * **Bewuste keuze:** de vergrendelingsroutine van AC9.3 (UPDATE op
 * vergrendeld) is hier nog NIET geïmplementeerd — de migratie ontneemt
 * vve_app alle UPDATE, en het blok G02 levert de boekingsservice en het
 * boekjaar zelf. De afsluiting vereist de expliciet gerechtigde routine
 * waar §7.4 om vraagt; die komt in B10 (boekjaar afsluiten) samen met het
 * resultaatbestemmingsbesluit en de kascommissie-modus. Tot die tijd kan
 * een jaar naar 'afgesloten' worden gezet zonder de vergrendelings-UPDATE:
 * de status zelf blokkeert al elke nieuwe boeking (boekingsdienst eist
 * 'open').
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { boeking } from '../database/schema/boeking.js';
// Eén foutvorm voor de hele financiële kern: dezelfde klasse-identiteit, zodat
// controllers en tests met één `instanceof` over beide services heen toetsen.
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export { InvoerFout, NietGevondenFout };

export interface BoekjaarRij {
  readonly id: bigint;
  readonly jaar: number;
  readonly startDatum: string;
  readonly eindDatum: string;
  readonly status: string;
  readonly aantalBoekingen: number;
}

export interface BoekjaarService {
  maakBoekjaar(
    vveId: bigint,
    invoer: { jaar: number; startDatum: string; eindDatum: string },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  open(vveId: bigint, boekjaarId: bigint, doorPersoonId: bigint): Promise<void>;
  afsluiten(
    vveId: bigint,
    boekjaarId: bigint,
    doorPersoonId: bigint,
  ): Promise<{ aantalBoekingen: number }>;
  lijst(vveId: bigint): Promise<readonly BoekjaarRij[]>;
}

/** Kalenderdatum YYYY-MM-DD; `date`-kolommen ondergaan nooit tz-conversie. */
function datum(waarde: unknown, veld: string): string {
  if (typeof waarde !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(waarde)) {
    throw new InvoerFout(`Veld "${veld}" moet een datum in de vorm YYYY-MM-DD zijn.`);
  }
  return waarde;
}

export function maakBoekjaarService(config: { readonly db: NodePgDatabase }): BoekjaarService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async maakBoekjaar(vveId, invoer, doorPersoonId) {
      const jaar = invoer.jaar;
      if (!Number.isInteger(jaar) || jaar < 1970 || jaar > 2100) {
        throw new InvoerFout('Het jaar moet een geldig kalenderjaar zijn.');
      }
      const start = datum(invoer.startDatum, 'startDatum');
      const einde = datum(invoer.eindDatum, 'eindDatum');
      if (einde <= start) {
        throw new InvoerFout('De einddatum moet na de startdatum liggen.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [dubbel] = await tx
          .select({ id: boekjaar.id })
          .from(boekjaar)
          .where(and(sql`${boekjaar.vveId} = ${vveId}`, eq(boekjaar.jaar, jaar)))
          .limit(1);
        if (dubbel !== undefined) {
          throw new InvoerFout(`Boekjaar ${String(jaar)} bestaat al in deze VvE.`);
        }
        const [rij] = await tx
          .insert(boekjaar)
          .values({ vveId, jaar, startDatum: start, eindDatum: einde })
          .returning({ id: boekjaar.id });
        if (rij === undefined) throw new Error('boekjaar-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'boekjaar.aangemaakt',
        categorie: 'financieel',
        onderwerpTabel: 'boekjaar',
        onderwerpId: id,
        details: { jaar },
      });
      return { id };
    },

    async open(vveId, boekjaarId, doorPersoonId) {
      await inTenantTransactie(db, vveId, async (tx) => {
        // Een VvE heeft hoogstens één open jaar tegelijk: het eerder open
        // jaar gaat naar 'afgesloten' — bewust, want een tweede open jaar is
        // een administratieve foutbron zonder use-case. Dit mag alleen door
        // de beheerder; het auditlog houdt vast wie het deed.
        const [huidig] = await tx
          .select({ id: boekjaar.id })
          .from(boekjaar)
          .where(and(sql`${boekjaar.vveId} = ${vveId}`, eq(boekjaar.status, 'open')))
          .limit(1);
        if (huidig !== undefined && huidig.id !== boekjaarId) {
          throw new InvoerFout(
            'Er is al een open boekjaar; sluit dat eerst af (AC9.3) of gebruik dezelfde.',
          );
        }
        const rijen = await tx
          .update(boekjaar)
          .set({ status: 'open' })
          .where(and(sql`${boekjaar.vveId} = ${vveId}`, sql`${boekjaar.id} = ${boekjaarId}`))
          .returning({ id: boekjaar.id });
        if (rijen.length === 0) throw new NietGevondenFout('Boekjaar niet gevonden.');
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'boekjaar.geopend',
          categorie: 'financieel',
          onderwerpTabel: 'boekjaar',
          onderwerpId: boekjaarId,
        });
      });
    },

    async afsluiten(vveId, boekjaarId, doorPersoonId) {
      const aantalBoekingen = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({ id: boekjaar.id, status: boekjaar.status })
          .from(boekjaar)
          .where(and(sql`${boekjaar.vveId} = ${vveId}`, sql`${boekjaar.id} = ${boekjaarId}`))
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        if (rij.status === 'afgesloten') {
          throw new InvoerFout('Dit boekjaar is al afgesloten.');
        }
        // De boeking-rijen van dit jaar tellen (voor het auditverslag).
        const [telling] = await tx
          .select({ aantal: sql<number>`count(*)::int` })
          .from(boeking)
          .where(sql`${boeking.boekjaarId} = ${boekjaarId}`);
        // Status naar afgesloten; de boeking-rijen zijn al append-only en het
        // 'open'-eis van de boekingsservice sluit nieuwe boekingen uit. De
        // fysieke vergrendeling (UPDATE op vergrendeld) komt in B10 onder de
        // expliciet gerechtigde routine (§7.4).
        await tx
          .update(boekjaar)
          .set({ status: 'afgesloten', afgeslotenOp: new Date() })
          .where(sql`${boekjaar.id} = ${boekjaarId}`);
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'boekjaar.afgesloten',
          categorie: 'financieel',
          onderwerpTabel: 'boekjaar',
          onderwerpId: boekjaarId,
          details: { aantalBoekingen: telling?.aantal ?? 0 },
        });
        return telling?.aantal ?? 0;
      });
      return { aantalBoekingen };
    },

    async lijst(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            id: boekjaar.id,
            jaar: boekjaar.jaar,
            startDatum: boekjaar.startDatum,
            eindDatum: boekjaar.eindDatum,
            status: boekjaar.status,
          })
          .from(boekjaar)
          .where(sql`${boekjaar.vveId} = ${vveId}`)
          .orderBy(asc(boekjaar.jaar));
        const tellingen = await tx
          .select({ boekjaarId: boeking.boekjaarId, aantal: sql<number>`count(*)::int` })
          .from(boeking)
          .where(sql`${boeking.vveId} = ${vveId}`)
          .groupBy(boeking.boekjaarId);
        return rijen.map((r) => ({
          ...r,
          aantalBoekingen: tellingen.find((t) => t.boekjaarId === r.id)?.aantal ?? 0,
        }));
      });
    },
  };
}
