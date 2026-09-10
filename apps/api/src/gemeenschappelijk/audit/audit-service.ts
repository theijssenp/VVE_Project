/**
 * Auditlog met hashketen — F09 (spec §6.8, test #38).
 *
 * Elke rechtenwijziging, elke financiële mutatie en elke inzage in
 * persoonsgegevens komt hier (§3.2). De keten is manipulatiebestendig:
 *
 *     eigen_hash = sha256(vorige_hash ‖ canonieke JSON van deze regel)
 *
 * met `vorige_hash = NULL` (⇒ de letterlijke tekst "null") voor de allereerste
 * regel. Wie een regel achteraf wijzigt of verwijdert, breekt de keten
 * aantoonbaar — de dagelijkse verificatie (`verifieerKeten`) detecteert het.
 *
 * De applicatierol heeft uitsluitend INSERT op audit_log (migratie 0007);
 * het teruglezen voor verificatie gebeurt via de eigenaar/migratierol.
 */

import { createHash } from 'node:crypto';

import { desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditLog } from '../../database/schema/audit-log.js';

/** De toegestane categorieën — gelijk aan de §7.9-logkanalen. */
export const CATEGORIEEN = ['app', 'financieel', 'beveiliging'] as const;
export type AuditCategorie = (typeof CATEGORIEEN)[number];

export interface AuditInvoer {
  /** VvE-scope; null bij systeem-brede acties (login, VvE-aanmaak). */
  readonly vveId: bigint | null;
  /** Wie de handeling deed; null bij systeemhandelingen. */
  readonly persoonId: bigint | null;
  /** Gebeurtenisnaam, bv. 'nota.genereer' of 'wachtwoord.reset'. */
  readonly gebeurtenis: string;
  readonly categorie: AuditCategorie;
  readonly onderwerpTabel?: string | null;
  readonly onderwerpId?: bigint | null;
  readonly details?: Record<string, unknown> | null;
  readonly ipAdres?: string | null;
  readonly gebruikerAgent?: string | null;
}

export interface Ketenuitslag {
  /** De laatste eigen_hash — de "hoofdhash" die dagelijks extern gepubliceerd wordt. */
  readonly hoofdhash: string;
  readonly aantal: number;
}

/** Fout bij een ketenschending (test #38). */
export class KetengebrokenFout extends Error {
  constructor(readonly opRij: number) {
    super(`Auditketen gebroken bij rij ${String(opRij)}`);
    this.name = 'KetengebrokenFout';
  }
}

/**
 * Canonieke JSON: sleutel-gesorteerde volgorde, geen whitespace, timestamps
 * als ISO-8601. Zelfde vorm bij schrijven en verifiëren — de keten is
 * deterministisch, ongeacht de kolomvolgorde van de database.
 */
export function canoniekeJson(invoer: Record<string, unknown>): string {
  return JSON.stringify(sorteerSleutels(invoer));
}

function sorteerSleutels(waarde: unknown): unknown {
  if (waarde === null || typeof waarde !== 'object') {
    return waarde;
  }
  if (Array.isArray(waarde)) {
    return waarde.map(sorteerSleutels);
  }
  const record = waarde as Record<string, unknown>;
  const uit: Record<string, unknown> = {};
  for (const sleutel of Object.keys(record).sort()) {
    uit[sleutel] = sorteerSleutels(record[sleutel]);
  }
  return uit;
}

/** eigen_hash = sha256(vorige_hash ‖ canonieke JSON). "null" als vorigeHash NULL is. */
export function hashOver(vorigeHash: string | null, regel: Record<string, unknown>): string {
  const voorganger = vorigeHash ?? 'null';
  return createHash('sha256')
    .update(voorganger + canoniekeJson(regel), 'utf8')
    .digest('hex');
}

export function maakAuditService(config: { readonly db: NodePgDatabase }): {
  registreer(invoer: AuditInvoer): Promise<{ id: bigint; eigenHash: string }>;
  verifieerKeten(): Promise<{ hoofdhash: string; aantal: number }>;
} {
  const { db } = config;

  return {
    async registreer(invoer) {
      // 1. De eigen_hash van de laatste rij — de keten is één lijn door de tijd.
      const [laatste] = await db
        .select({ eigenHash: auditLog.eigenHash })
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(1);
      const vorigeHash = laatste?.eigenHash ?? null;

      // 2. De hash over vorige_hash ‖ canonieke JSON van de regel.
      const gebeurtenisOp = new Date();
      const regel = regelInhoud(invoer, gebeurtenisOp);
      const eigenHash = hashOver(vorigeHash, regel);

      // 3. Insert (alleen-INSERT-recht op de rol; de rij is daarna immutable).
      const [rij] = await db
        .insert(auditLog)
        .values({
          vveId: invoer.vveId,
          persoonId: invoer.persoonId,
          gebeurtenis: invoer.gebeurtenis,
          categorie: invoer.categorie,
          onderwerpTabel: invoer.onderwerpTabel ?? null,
          onderwerpId: invoer.onderwerpId ?? null,
          details: invoer.details ?? null,
          ipAdres: invoer.ipAdres ?? null,
          gebruikerAgent: invoer.gebruikerAgent ?? null,
          gebeurtenisOp: gebeurtenisOp,
          vorigeHash,
          eigenHash,
        })
        .returning({ id: auditLog.id });
      if (rij === undefined) {
        throw new Error('audit_log-insert leverde geen rij op');
      }
      return { id: rij.id, eigenHash };
    },

    async verifieerKeten() {
      // Verificatie leest de rijen in volgorde en bouwt de keten na. De
      // gebeurtenis_op wordt uit de database gelezen — de hash geldt voor de
      // opgeslagen waarde, niet voor een opnieuw-gemaakte timestamp.
      const rijen = await db
        .select()
        .from(auditLog)
        .orderBy(auditLog.id);

      let vorige: string | null = null;
      for (const rij of rijen) {
        const regel = {
          vve_id: rij.vveId === null ? null : String(rij.vveId),
          persoon_id: rij.persoonId === null ? null : String(rij.persoonId),
          gebeurtenis: rij.gebeurtenis,
          categorie: rij.categorie,
          onderwerp_tabel: rij.onderwerpTabel,
          onderwerp_id: rij.onderwerpId === null ? null : String(rij.onderwerpId),
          details: rij.details,
          ip_adres: rij.ipAdres,
          gebruiker_agent: rij.gebruikerAgent,
          gebeurtenis_op: rij.gebeurtenisOp.toISOString(),
        };
        const verwacht = hashOver(vorige, regel);
        if (rij.vorigeHash !== vorige || rij.eigenHash !== verwacht) {
          throw new KetengebrokenFout(Number(rij.id));
        }
        vorige = rij.eigenHash;
      }
      const hoofdhash = rijen[rijen.length - 1]?.eigenHash ?? '';
      return { hoofdhash, aantal: rijen.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Regel-inhoud: de canonieke vorm bij schrijven én verifiëren.
// ---------------------------------------------------------------------------

function regelInhoud(invoer: AuditInvoer, gebeurtenisOp: Date): Record<string, unknown> {
  return {
    vve_id: invoer.vveId === null ? null : String(invoer.vveId),
    persoon_id: invoer.persoonId === null ? null : String(invoer.persoonId),
    gebeurtenis: invoer.gebeurtenis,
    categorie: invoer.categorie,
    onderwerp_tabel: invoer.onderwerpTabel ?? null,
    onderwerp_id:
      invoer.onderwerpId === null || invoer.onderwerpId === undefined
        ? null
        : String(invoer.onderwerpId),
    details: invoer.details ?? null,
    ip_adres: invoer.ipAdres ?? null,
    gebruiker_agent: invoer.gebruikerAgent ?? null,
    gebeurtenis_op: gebeurtenisOp.toISOString(),
  };
}

/** Hulp voor de verifieer-loop: dezelfde regelvorm uit een gelezen rij. */
export function regelInhoudUitRij(rij: {
  vveId: bigint | null;
  persoonId: bigint | null;
  gebeurtenis: string;
  categorie: string;
  onderwerpTabel: string | null;
  onderwerpId: bigint | null;
  details: unknown;
  ipAdres: string | null;
  gebruikerAgent: string | null;
  gebeurtenisOp: Date;
}): Record<string, unknown> {
  return {
    vve_id: rij.vveId === null ? null : String(rij.vveId),
    persoon_id: rij.persoonId === null ? null : String(rij.persoonId),
    gebeurtenis: rij.gebeurtenis,
    categorie: rij.categorie,
    onderwerp_tabel: rij.onderwerpTabel,
    onderwerp_id: rij.onderwerpId === null ? null : String(rij.onderwerpId),
    details: rij.details,
    ip_adres: rij.ipAdres,
    gebruiker_agent: rij.gebruikerAgent,
    gebeurtenis_op: rij.gebeurtenisOp.toISOString(),
  };
}