/**
 * Grootboekservice — blok G01 (spec §5.7, §6.7 · AC9.1).
 *
 * Twee verantwoordelijkheden:
 *   1. `kopiesTandaardSchema` — bij het aanmaken van een VvE het §5.7-schema
 *      in één transactie kopieëren (RLS-pad). Idempotent: bestaat het nummer
 *      al, dan wordt het overgeslagen (een VvE kan niet tweemaal worden
 *      geseed).
 *   2. Rekeningbeheer — toevoegen, wijzigen (naam/actief), lijst. Verwijderen
 *      is bewust niet mogelijk: een rekening zonder boekingen deactiveren
 *      kan, en het schema groeit alleen maar — de rekeningnummers zijn de
 *      ankers van het auditverleden (G02's append-only-boekingen hangen er
 *      straks aan).
 */

import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { grootboekrekening } from '../database/schema/grootboekrekening.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { standaardGrootboekschema } from './grootboek-schema.js';

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

export interface RekeningRij {
  readonly id: bigint;
  readonly nummer: string;
  readonly naam: string;
  readonly categorie: string;
  readonly isReservefonds: boolean;
  readonly actief: boolean;
}

export interface GrootboekService {
  /** Kopieert het §5.7-schema naar de VvE; idempotent. */
  kopieerStandaardSchema(vveId: bigint): Promise<{ aantal: number }>;
  lijst(vveId: bigint, alleenActief?: boolean): Promise<readonly RekeningRij[]>;
  voegToe(
    vveId: bigint,
    invoer: { nummer: string; naam: string; categorie: string; isReservefonds?: boolean },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  wijzig(
    vveId: bigint,
    id: bigint,
    wijziging: { naam?: string | undefined; actief?: boolean | undefined },
    doorPersoonId: bigint,
  ): Promise<void>;
}

export function maakGrootboekService(config: {
  readonly db: NodePgDatabase;
  /** Gereserveerd voor toekomstige tijdsafhankelijke regels; bewust al in de config. */
  readonly klok: Klok;
}): GrootboekService {
  const { db } = config;
  const audit = maakAuditService({ db });

  const CATEGORIEEN = new Set(['activa', 'passiva', 'eigen_vermogen', 'lasten', 'baten']);

  return {
    async kopieerStandaardSchema(vveId) {
      const schema = standaardGrootboekschema(vveId);
      const aantal = await inTenantTransactie(db, vveId, async (tx) => {
        // Idempotent: wat er al staat niet opnieuw sturen.
        const bestaand = await tx
          .select({ nummer: grootboekrekening.nummer })
          .from(grootboekrekening)
          .where(eq(grootboekrekening.vveId, vveId));
        const aanwezig = new Set(bestaand.map((r) => r.nummer));
        const teInserten = schema.filter((r) => !aanwezig.has(r.nummer));
        if (teInserten.length === 0) return 0;
        await tx.insert(grootboekrekening).values(teInserten);
        return teInserten.length;
      });
      if (aantal > 0) {
        await audit.registreer({
          vveId,
          persoonId: null,
          gebeurtenis: 'grootboek.schema_gekopieerd',
          categorie: 'app',
          onderwerpTabel: 'grootboekrekening',
          onderwerpId: null,
          details: { aantal },
        });
      }
      return { aantal };
    },

    async lijst(vveId, alleenActief = false) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const condities = [eq(grootboekrekening.vveId, vveId)];
        if (alleenActief) condities.push(eq(grootboekrekening.actief, true));
        const rijen = await tx
          .select({
            id: grootboekrekening.id,
            nummer: grootboekrekening.nummer,
            naam: grootboekrekening.naam,
            categorie: grootboekrekening.categorie,
            isReservefonds: grootboekrekening.isReservefonds,
            actief: grootboekrekening.actief,
          })
          .from(grootboekrekening)
          .where(and(...condities))
          .orderBy(asc(grootboekrekening.nummer));
        return rijen;
      });
    },

    async voegToe(vveId, invoer, doorPersoonId) {
      const nummer = invoer.nummer.trim();
      const naam = invoer.naam.trim();
      if (nummer === '' || naam === '') {
        throw new InvoerFout('Nummer en naam van een rekening zijn verplicht.');
      }
      if (!CATEGORIEEN.has(invoer.categorie)) {
        throw new InvoerFout('Onbekende grootboekcategorie.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [dubbel] = await tx
          .select({ id: grootboekrekening.id })
          .from(grootboekrekening)
          .where(and(eq(grootboekrekening.vveId, vveId), eq(grootboekrekening.nummer, nummer)))
          .limit(1);
        if (dubbel !== undefined) {
          throw new InvoerFout(`Rekening ${nummer} bestaat al in deze VvE.`);
        }
        const [rij] = await tx
          .insert(grootboekrekening)
          .values({
            vveId,
            nummer,
            naam,
            categorie: invoer.categorie as
              'activa' | 'passiva' | 'eigen_vermogen' | 'lasten' | 'baten',
            isReservefonds: invoer.isReservefonds ?? false,
          })
          .returning({ id: grootboekrekening.id });
        if (rij === undefined) throw new Error('grootboekrekening-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'grootboek.rekening_toegevoegd',
        categorie: 'app',
        onderwerpTabel: 'grootboekrekening',
        onderwerpId: id,
        details: { nummer },
      });
      return { id };
    },

    async wijzig(vveId, id, wijziging, doorPersoonId) {
      await inTenantTransactie(db, vveId, async (tx) => {
        const set: Record<string, unknown> = {};
        if (wijziging.naam !== undefined) {
          const naam = wijziging.naam.trim();
          if (naam === '') throw new InvoerFout('Naam mag niet leeg zijn.');
          set['naam'] = naam;
        }
        if (wijziging.actief !== undefined) set['actief'] = wijziging.actief;
        if (Object.keys(set).length === 0) return;
        const rijen = await tx
          .update(grootboekrekening)
          .set(set)
          .where(and(eq(grootboekrekening.id, id), eq(grootboekrekening.vveId, vveId)))
          .returning({ id: grootboekrekening.id });
        if (rijen.length === 0) {
          throw new NietGevondenFout('Rekening niet gevonden in deze VvE.');
        }
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'grootboek.rekening_gewijzigd',
          categorie: 'app',
          onderwerpTabel: 'grootboekrekening',
          onderwerpId: id,
        });
      });
    },
  };
}
