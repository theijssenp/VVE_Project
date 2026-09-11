/**
 * Betaling-service — blok G08 (spec §6.6, M6 · AC6.3 · tests #8–#9).
 *
 * De geldstroom in: een betaling (van de bank, kas of handmatig) wordt
 * gekoppeld aan één of meer nota's. Drie gevallen (AC6.3):
 *
 *   1. **Volledige betaling** — som(koppelingen) == nota.openstaand →
 *      status `betaald`, openstaand 0.
 *   2. **Deelbetaling** (test #8) — minder dan de nota → status
 *      `deels_betaald`, openstaand het restant.
 *   3. **Vooruitbetaling** (test #9) — méér dan de open nota's → het restje
 *      blijft als creditsaldo op de eenheid staan en verrekent automatisch
 *      met de eerstvolgende nota: bij het *genereren* van een nieuwe nota
 *      (G06) koppelt `verwerkCreditsaldo` het saldo automatisch tegen de
 *      nieuwe vordering.
 *
 * **Append-only.** Betalingen worden nooit gemuteerd; een foutieve koppeling
 * wordt gecorrigeerd met een tegengestelde betaling (bron `verrekening`).
 *
 * **Statusflow bewaakt.** `openstaand_cent` is afgeleid (nota.bedrag −
 * som(koppelingen)); elke koppeling herberekent de betrokken nota's in dezelfde
 * transactie. `overkoppeling` (meer koppelen dan de nota groot is) wordt
 * geweigerd; de *som* over de nota's mag wél lager zijn dan de betaling — dat
 * restje is het creditsaldo (test #9), bewaard in `creditsaldo_cent` op de
 * eenheid (afgeleid, live gerekend).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { betaling, betalingKoppeling } from '../database/schema/betaling.js';
import { nota } from '../database/schema/nota.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export interface BetalingRij {
  readonly id: bigint;
  readonly datum: string;
  readonly bedragCent: number;
  readonly bron: string;
  readonly wooneenheidId: bigint | null;
  readonly omschrijving: string | null;
  readonly gekoppeldCenten: number;
  readonly saldoCenten: number;
}

export interface NotaStatusRij {
  readonly id: bigint;
  readonly nummer: string;
  readonly status: string;
  readonly bedragCent: number;
  readonly openstaandCent: number;
}

export interface BetalingService {
  /** AC6.3: registreert een betaling en koppelt haar aan nota's. */
  registreer(
    vveId: bigint,
    invoer: {
      readonly datum: string;
      readonly bedragCent: number;
      readonly bron: 'bank' | 'kas' | 'handmatig' | 'incasso' | 'verrekening';
      readonly wooneenheidId: bigint;
      readonly koppelingen: readonly { notaId: bigint; bedragCent: number }[];
      readonly omschrijving?: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint; gekoppeldCenten: number; creditsaldoCenten: number }>;
  /** Het creditsaldo van een eenheid: betaald − gekoppeld (test #9). */
  creditsaldo(vveId: bigint, wooneenheidId: bigint): Promise<number>;
  /** De betalingen van de VvE, optioneel per eenheid. */
  lijst(vveId: bigint, wooneenheidId?: bigint): Promise<readonly BetalingRij[]>;
  /** De notastatussen van een eenheid (na koppeling). */
  notastatus(vveId: bigint, wooneenheidId: bigint): Promise<readonly NotaStatusRij[]>;
}

export function maakBetalingService(config: { readonly db: NodePgDatabase }): BetalingService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async registreer(vveId, invoer, doorPersoonId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoer.datum)) {
        throw new InvoerFout('Veld "datum" moet de vorm YYYY-MM-DD hebben.');
      }
      if (invoer.bedragCent < 0) {
        throw new InvoerFout('Het bedrag kan niet negatief zijn; corrigeer met "verrekening".');
      }
      if (invoer.koppelingen.length === 0) {
        throw new InvoerFout('Minstens één koppeling op een nota is verplicht (AC6.3).');
      }
      const somKoppelingen = invoer.koppelingen.reduce((t, k) => t + k.bedragCent, 0);
      if (somKoppelingen > invoer.bedragCent) {
        throw new InvoerFout(
          'De koppelingen overstijgen de betaalde som; deel het bedrag opnieuw op.',
        );
      }

      const { id, gekoppeldCenten, creditsaldoCenten } = await inTenantTransactie(
        db,
        vveId,
        async (tx) => {
          // Elke gekoppelde nota moet in deze tenant open zijn; vergrendel
          // ze in vastgelegde volgorde (id) om deadlocks te vermijden.
          const notaIds = [...invoer.koppelingen.map((k) => k.notaId)].sort((a, b) =>
            a < b ? -1 : 1,
          );
          const notarijen = await tx
            .select({ id: nota.id, nummer: nota.nummer, status: nota.status })
            .from(nota)
            .where(and(eq(nota.vveId, vveId), inArray(nota.id, notaIds)))
            .for('update', { of: nota });
          const geindexeerd = new Map(notarijen.map((r) => [r.id, r]));
          for (const k of invoer.koppelingen) {
            const rij = geindexeerd.get(k.notaId);
            if (rij === undefined) {
              throw new InvoerFout(`Nota ${String(k.notaId)} bestaat niet in deze VvE.`);
            }
            if (k.bedragCent <= 0) {
              throw new InvoerFout('Elke koppeling heeft een positief bedrag nodig.');
            }
          }

          const [rij] = await tx
            .insert(betaling)
            .values({
              vveId,
              wooneenheidId: invoer.wooneenheidId,
              datum: invoer.datum,
              bedragCent: invoer.bedragCent,
              bron: invoer.bron,
              omschrijving: invoer.omschrijving ?? null,
            })
            .returning({ id: betaling.id });
          if (rij === undefined) throw new Error('betaling-insert leverde geen id op');

          let gekoppeld = 0;
          for (const k of invoer.koppelingen) {
            // De nota mag niet overkoppeld worden: openstaand >= koppelbedrag.
            const [telling] = await tx
              .select({
                bedrag: nota.bedragCent,
                nummer: nota.nummer,
                status: nota.status,
                gekoppeld: sql<number>`(
                SELECT COALESCE(SUM(k.bedrag_cent), 0)::int
                  FROM betaling_koppeling k
                 WHERE k.nota_id = ${k.notaId}
              )`,
              })
              .from(nota)
              .where(and(eq(nota.vveId, vveId), eq(nota.id, k.notaId)))
              .for('update', { of: nota });
            if (telling === undefined) throw new NietGevondenFout('Nota niet gevonden.');
            if (telling.status !== 'open' && telling.status !== 'deels_betaald') {
              throw new InvoerFout(
                `Nota ${telling.nummer} is niet open (status ${telling.status}); koppelen kan alleen op open nota's.`,
              );
            }
            const openstaand = telling.bedrag - telling.gekoppeld;
            if (k.bedragCent > openstaand) {
              throw new InvoerFout(
                `Koppeling overstijgt het openstaande bedrag (${String(k.bedragCent)} > ${String(openstaand)}).`,
              );
            }
            await tx.insert(betalingKoppeling).values({
              betalingId: rij.id,
              notaId: k.notaId,
              bedragCent: k.bedragCent,
            });
            gekoppeld += k.bedragCent;

            // Afgeleide velden: openstaand en status.
            const nieuwOpenstaand = telling.bedrag - telling.gekoppeld - k.bedragCent;
            const nieuweStatus =
              nieuwOpenstaand === 0
                ? 'betaald'
                : telling.gekoppeld + k.bedragCent > 0
                  ? 'deels_betaald'
                  : 'open';
            await tx
              .update(nota)
              .set({ openstaandCent: nieuwOpenstaand, status: nieuweStatus })
              .where(and(eq(nota.vveId, vveId), eq(nota.id, k.notaId)));
          }

          // Creditsaldo (test #9): betaald − gekoppeld, op de eenheid bewaakt.
          const saldo = invoer.bedragCent - gekoppeld;
          return { id: rij.id, gekoppeldCenten: gekoppeld, creditsaldoCenten: saldo };
        },
      );

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'betaling.geregistreerd',
        categorie: 'financieel',
        onderwerpTabel: 'betaling',
        onderwerpId: id,
        details: {
          datum: invoer.datum,
          bedragCent: invoer.bedragCent,
          gekoppeldCenten,
          creditsaldoCenten,
        },
      });
      return { id, gekoppeldCenten, creditsaldoCenten };
    },

    async creditsaldo(vveId, wooneenheidId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({
            betaald: sql<number>`COALESCE(SUM(${betaling.bedragCent}), 0)::int`,
          })
          .from(betaling)
          .where(and(eq(betaling.vveId, vveId), eq(betaling.wooneenheidId, wooneenheidId)));
        const [gekoppeldRij] = await tx
          .select({
            gekoppeld: sql<number>`COALESCE(SUM(${betalingKoppeling.bedragCent}), 0)::int`,
          })
          .from(betalingKoppeling)
          .innerJoin(betaling, eq(betaling.id, betalingKoppeling.betalingId))
          .where(and(eq(betaling.vveId, vveId), eq(betaling.wooneenheidId, wooneenheidId)));
        const saldo = (rij?.betaald ?? 0) - (gekoppeldRij?.gekoppeld ?? 0);
        return Math.max(0, saldo);
      });
    },

    async lijst(vveId, wooneenheidId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const voorwaarde =
          wooneenheidId === undefined
            ? eq(betaling.vveId, vveId)
            : and(eq(betaling.vveId, vveId), eq(betaling.wooneenheidId, wooneenheidId));
        const rijen = await tx
          .select({
            id: betaling.id,
            datum: betaling.datum,
            bedragCent: betaling.bedragCent,
            bron: betaling.bron,
            wooneenheidId: betaling.wooneenheidId,
            omschrijving: betaling.omschrijving,
            gekoppeld: sql<number>`(
              SELECT COALESCE(SUM(k.bedrag_cent), 0)::int
                FROM betaling_koppeling k
               WHERE k.betaling_id = ${betaling.id}
            )`,
          })
          .from(betaling)
          .where(voorwaarde);
        return rijen.map((r) => ({
          id: r.id,
          datum: r.datum,
          bedragCent: r.bedragCent,
          bron: r.bron,
          wooneenheidId: r.wooneenheidId,
          omschrijving: r.omschrijving,
          gekoppeldCenten: r.gekoppeld,
          saldoCenten: r.bedragCent - r.gekoppeld,
        }));
      });
    },

    async notastatus(vveId, wooneenheidId) {
      return inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            id: nota.id,
            nummer: nota.nummer,
            status: nota.status,
            bedragCent: nota.bedragCent,
            openstaandCent: nota.openstaandCent,
          })
          .from(nota)
          .innerJoin(wooneenheid, eq(wooneenheid.id, nota.wooneenheidId))
          .where(and(eq(nota.vveId, vveId), eq(wooneenheid.id, wooneenheidId))),
      );
    },
  };
}
