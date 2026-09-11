/**
 * Aanmaning-service — blok G11 (spec §5.5, M6 · AC6.5/AC6.6).
 *
 * **Traject (AC6.5):** herinnering (T+7 na verval, kosteloos) → aanmaning
 * (T+21, met de wettelijke veertiendagenbrief waarin de incassokosten
 * expliciet worden aangezegd) → ingebrekestelling (T+45). Termijnen
 * instelbaar per VvE (`aanmaning_instelling`, defaults §5.5). Elke stap is
 * één rij in `aanmaning` (UNIQUE nota+stap — nooit twee keer herinnerd),
 * met de brieftekst als bewijs.
 *
 * **Kosten (AC6.6):** incassokosten volgens de WIK-staffel: 15% over de
 * eerste € 2.500, minimum € 40. Rente naar de gekozen grondslag
 * ('wettelijk'/'reglementair' = instelbaar percentage per maand; 'geen').
 * Rente én incassokosten gaan als APARTE nota (`type` 'rente' resp.
 * 'incassokosten'), nooit als aanpassing van de oorspronkelijke nota. De
 * kosten-nota hergebruikt de G06-nummerreeks (FOR UPDATE op het boekjaar).
 *
 * **Volgorde bewaakt:** een stap mag pas als de vorige verstuurd is én de
 * termijn (verval + dagen van de nieuwe stap) bereikt is.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { aanmaning, aanmaningInstelling } from '../database/schema/aanmaning.js';
import { nota } from '../database/schema/nota.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

/** WIK-staffel §5.5: 15% over het openstaande, minimum € 40. */
export function wikKosten(openstaandCent: number): number {
  return Math.max(4_000, Math.floor(Math.max(0, openstaandCent) * 0.15));
}

type Stap = 'herinnering' | 'aanmaning' | 'ingebrekestelling';

const VOLGORDE: readonly Stap[] = ['herinnering', 'aanmaning', 'ingebrekestelling'];

export interface AanmaningService {
  /** Zet de instellingen (termijnen, rentegrondslag) voor de VvE. */
  zetInstellingen(
    vveId: bigint,
    invoer: {
      herinneringDagen?: number;
      aanmaningDagen?: number;
      ingebrekestellingDagen?: number;
      renteGrondslag?: 'wettelijk' | 'reglementair' | 'geen';
      rentePercentage?: string;
    },
    doorPersoonId: bigint,
  ): Promise<void>;
  /** Verstuurt de volgende stap voor een open nota (AC6.5). */
  verstuurStap(
    vveId: bigint,
    notaId: bigint,
    peildatum: string,
    doorPersoonId: bigint,
  ): Promise<{
    readonly stap: string;
    readonly isVeertiendagen: boolean;
    readonly kostenNotaId: bigint | null;
    readonly incassokostenCent: number;
    readonly renteCent: number;
  }>;
  /** Het traject van één nota. */
  traject(
    vveId: bigint,
    notaId: bigint,
  ): Promise<
    readonly {
      readonly stap: string;
      readonly verstuurdOp: string;
      readonly isVeertiendagen: boolean;
      readonly kostenCent: number;
    }[]
  >;
}

export function maakAanmaningService(config: { readonly db: NodePgDatabase }): AanmaningService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async zetInstellingen(vveId, invoer, doorPersoonId) {
      await inTenantTransactie(db, vveId, async (tx) => {
        const bestaand = await tx
          .select({ vveId: aanmaningInstelling.vveId })
          .from(aanmaningInstelling)
          .where(eq(aanmaningInstelling.vveId, vveId))
          .limit(1);
        const waarden = {
          ...(invoer.herinneringDagen !== undefined
            ? { herinneringDagen: invoer.herinneringDagen }
            : {}),
          ...(invoer.aanmaningDagen !== undefined ? { aanmaningDagen: invoer.aanmaningDagen } : {}),
          ...(invoer.ingebrekestellingDagen !== undefined
            ? { ingebrekestellingDagen: invoer.ingebrekestellingDagen }
            : {}),
          ...(invoer.renteGrondslag !== undefined ? { renteGrondslag: invoer.renteGrondslag } : {}),
          ...(invoer.rentePercentage !== undefined
            ? { rentePercentage: invoer.rentePercentage }
            : {}),
        };
        if (bestaand.length === 0) {
          await tx.insert(aanmaningInstelling).values({ vveId, ...waarden });
        } else {
          await tx
            .update(aanmaningInstelling)
            .set(waarden)
            .where(eq(aanmaningInstelling.vveId, vveId));
        }
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'aanmaning.instellingen_gewijzigd',
        categorie: 'financieel',
        onderwerpTabel: 'aanmaning_instelling',
        onderwerpId: vveId,
        details: { ...invoer },
      });
    },

    async verstuurStap(vveId, notaId, peildatum, doorPersoonId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(peildatum)) {
        throw new InvoerFout('Peildatum moet de vorm YYYY-MM-DD hebben.');
      }

      const uitkomst = await inTenantTransactie(db, vveId, async (tx) => {
        // De nota, vergrendeld, moet open zijn.
        const [notaRij] = await tx
          .select({
            id: nota.id,
            nummer: nota.nummer,
            status: nota.status,
            vervaldatum: nota.vervaldatum,
            openstaandCent: nota.openstaandCent,
            wooneenheidId: nota.wooneenheidId,
            persoonId: nota.persoonId,
            boekjaarId: nota.boekjaarId,
          })
          .from(nota)
          .where(and(eq(nota.vveId, vveId), eq(nota.id, notaId)))
          .for('update', { of: nota });
        if (notaRij === undefined) throw new NietGevondenFout('Nota niet gevonden.');
        if (notaRij.status !== 'open' && notaRij.status !== 'deels_betaald') {
          throw new InvoerFout('Aanmanen kan alleen op open nota’s.');
        }

        // Instellingen (defaults §5.5 als er geen rij is).
        const [inst] = await tx
          .select()
          .from(aanmaningInstelling)
          .where(eq(aanmaningInstelling.vveId, vveId))
          .limit(1);
        const termijnDagen = {
          herinnering: inst?.herinneringDagen ?? 7,
          aanmaning: inst?.aanmaningDagen ?? 21,
          ingebrekestelling: inst?.ingebrekestellingDagen ?? 45,
        };
        const renteGrondslag = inst?.renteGrondslag ?? 'wettelijk';
        const rentePercentage = inst?.rentePercentage ?? '0';

        // De eerste nog-niet-verstuurde stap is de volgende.
        const bestaand = await tx
          .select({ stap: aanmaning.stap })
          .from(aanmaning)
          .where(eq(aanmaning.notaId, notaId));
        const alVerstuurd = new Set(bestaand.map((r) => r.stap));
        const volgende = VOLGORDE.find((stap) => !alVerstuurd.has(stap));
        if (volgende === undefined) {
          throw new InvoerFout('Het volledige traject is al doorlopen.');
        }
        const index = VOLGORDE.indexOf(volgende);
        if (index > 0) {
          const vorige = VOLGORDE[index - 1];
          if (vorige !== undefined && !alVerstuurd.has(vorige)) {
            throw new InvoerFout(`De stap "${vorige}" is nog niet verstuurd.`);
          }
        }

        // Termijn: verval + dagen van deze stap moet bereikt zijn.
        const dagen = termijnDagen[volgende];
        const deadline = new Date(`${notaRij.vervaldatum}T00:00:00Z`);
        deadline.setUTCDate(deadline.getUTCDate() + dagen);
        if (new Date(`${peildatum}T00:00:00Z`) < deadline) {
          throw new InvoerFout(
            `Deze stap mag pas op of na ${deadline.toISOString().slice(0, 10)} (T+${String(dagen)} na verval).`,
          );
        }

        // Kosten (AC6.6): aanmaning zegt WIK-incassokosten aangezegd; de
        // ingebrekestelling boekt rente + de incassokosten als APARTE nota.
        let incassokostenCent = 0;
        let renteCent = 0;
        if (volgende === 'aanmaning') {
          incassokostenCent = wikKosten(notaRij.openstaandCent);
        }
        if (volgende === 'ingebrekestelling' && renteGrondslag !== 'geen') {
          const percentage = Number(rentePercentage);
          if (percentage > 0) {
            // Per maand, naar het openstaande; afgerond naar beneden.
            renteCent = Math.floor((notaRij.openstaandCent * percentage) / 100 / 12);
          }
        }

        const isVeertiendagen = volgende === 'aanmaning';
        const kostenEuro = (incassokostenCent / 100).toFixed(2);
        const teksten: Record<Stap, string> = {
          herinnering: `Herinnering: nota ${notaRij.nummer} is vervallen op ${notaRij.vervaldatum}. Wij verzoeken u vriendelijk het openstaande bedrag binnen 7 dagen te voldoen. (Kosteloos)`,
          aanmaning: `AANMANING nota ${notaRij.nummer}: het openstaande bedrag is niet betaald. Incassokosten van € ${kostenEuro} zijn aangezegd. Bij niet-betaling binnen 14 dagen volgt ingebrekestelling.`,
          ingebrekestelling: `INGEBREKESTELLING (WIK) nota ${notaRij.nummer}: u verkeert in verzuim. Het volledige openstaande bedrag, vermeerderd met rente en incassokosten, wordt nu gevorderd.`,
        };

        await tx.insert(aanmaning).values({
          vveId,
          notaId,
          stap: volgende,
          verstuurdOp: peildatum,
          tekst: teksten[volgende],
          isVeertiendagen,
          kostenCent: incassokostenCent,
        });

        // AC6.6: kosten als APARTE nota (type 'incassokosten' of 'rente'),
        // met nummer uit de G06-reeks: FOR UPDATE op het boekjaar.
        let kostenNotaId: bigint | null = null;
        const kostenTotaal = incassokostenCent + renteCent;
        if (kostenTotaal > 0) {
          // FOR UPDATE op de boekjaar-rij (G06-patroon).
          await tx.execute(
            sql`SELECT id FROM boekjaar WHERE id = ${notaRij.boekjaarId} FOR UPDATE`,
          );
          const [telling] = await tx
            .select({ aantal: sql<number>`count(*)::int` })
            .from(nota)
            .where(sql`${nota.boekjaarId} = ${notaRij.boekjaarId}`);
          let volgnr = telling?.aantal ?? 0;
          volgnr += 1;
          const jaar = peildatum.slice(0, 4);
          const nummer = `${jaar}-${String(volgnr).padStart(4, '0')}`;
          const [kostenRij] = await tx
            .insert(nota)
            .values({
              vveId,
              wooneenheidId: notaRij.wooneenheidId,
              persoonId: notaRij.persoonId,
              boekjaarId: notaRij.boekjaarId,
              nummer,
              type: incassokostenCent > 0 ? 'incassokosten' : 'rente',
              periodeVan: null,
              periodeTot: null,
              factuurdatum: peildatum,
              vervaldatum: over14Dagen(peildatum),
              bedragCent: kostenTotaal,
              openstaandCent: kostenTotaal,
              betaalwijze: 'overboeking',
              betalingskenmerk: `NOTA${nummer}`,
              status: 'open',
            })
            .returning({ id: nota.id });
          if (kostenRij === undefined) throw new Error('kosten-nota-insert leverde geen id op');
          kostenNotaId = kostenRij.id;
        }

        return {
          stap: volgende,
          isVeertiendagen,
          kostenNotaId,
          incassokostenCent,
          renteCent,
        };
      });

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'aanmaning.verstuurd',
        categorie: 'financieel',
        onderwerpTabel: 'aanmaning',
        onderwerpId: 0n,
        details: {
          notaId: String(notaId),
          ...uitkomst,
          kostenNotaId: uitkomst.kostenNotaId === null ? null : String(uitkomst.kostenNotaId),
        },
      });
      return uitkomst;
    },

    async traject(vveId, notaId) {
      return inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            stap: aanmaning.stap,
            verstuurdOp: aanmaning.verstuurdOp,
            isVeertiendagen: aanmaning.isVeertiendagen,
            kostenCent: aanmaning.kostenCent,
          })
          .from(aanmaning)
          .where(eq(aanmaning.notaId, notaId))
          .orderBy(aanmaning.verstuurdOp),
      );
    },
  };
}

/** 14 dagen na de gegeven datum (vervaltermijn default §5.5). */
function over14Dagen(datum: string): string {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
}
