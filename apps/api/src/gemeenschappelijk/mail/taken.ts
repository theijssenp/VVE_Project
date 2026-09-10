/**
 * Terugkerende taken via pg-boss — F10 (spec §7.7).
 *
 * pg-boss beheert zijn eigen schema in de database; de taken zijn idempotent
 * en draaien onder een lock (§7.7). Deze module stelt de planner in:
 *
 *   mail:verwerk          — 1 min  — verstuur de wachtrij, backoff, max 5 pogingen.
 *   audit:verifieer_keten — dagelijks — controleer de keten, mail de hoofdhash
 *                           naar het bestuur (de externe publicatie, §7.9).
 *
 * De taken zijn dunne functies die de services aanroepen; de tests kunnen de
 * taakinhoud deterministisch draaien zonder scheduler.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { maakAuditService } from '../audit/audit-service.js';

interface BossLike {
  schedule(naam: string, cron: string, opties?: { tz?: string }): Promise<unknown>;
}

export const TAK_NAAM_MAIL = 'mail:verwerk' as const;
export const TAK_NAAM_AUDIT = 'audit:verifieer_keten' as const;

/** De §7.7-taakdefinities. */
export const TAKEN = [
  { naam: TAK_NAAM_MAIL, cron: '*/1 * * * *', opties: {} },
  {
    naam: TAK_NAAM_AUDIT,
    cron: '0 6 * * *',
    opties: { tz: 'Europe/Amsterdam' },
  },
] as const;

export function maakTaakRegisseur(config: {
  readonly boss: BossLike;
  readonly db: NodePgDatabase;
}): {
  /** Plant de terugkerende taken (bij het opstarten). */
  plantTerugkerend(): Promise<void>;
  /**
   * De audit-verificatie-taakinhoud: verifieert de keten en retourneert de
   * hoofdhash. De beller (taak of test) beslist wat er mee gebeurt.
   */
  auditVerificatieTaak: () => Promise<{ hoofdhash: string; aantal: number }>;
} {
  const { boss, db } = config;
  const audit = maakAuditService({ db });

  return {
    async plantTerugkerend() {
      for (const taak of TAKEN) {
        await boss.schedule(taak.naam, taak.cron, taak.opties);
      }
    },
    auditVerificatieTaak: async () => {
      return audit.verifieerKeten();
    },
  };
}
