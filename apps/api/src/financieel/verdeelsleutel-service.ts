/**
 * Verdeelsleutels-service — blok G03 (spec §6.5, M4 · AC4.1–AC4.5).
 *
 * Vijf typen (§6.1): breukdeel, vierkante_meters, gelijke_delen, stemmen,
 * handmatig. De gewichten per eenheid worden NIET opgeslagen voor de
 * afgeleide typen: bij `breukdeel` is het gewicht de teller van de eenheid
 * (de noemer komt van de VvE), bij `vierkante_meters` de oppervlakte, bij
 * `gelijke_delen` 1, bij `stemmen` het aantal stemmen — die worden uit de
 * database gerekend op het moment van verdeling (AC4.4: de voorbeeld-
 * berekening klopt met de stand van het moment). Alleen `handmatig` slaat
 * zijn gewichten op in `verdeelsleutel_regel` (AC4.2).
 *
 * **Uitsluiting (AC4.2):** een regel met gewicht 0 (handmatig) of een
 * uitsluitingsregel (de afgeleide typen) laat de eenheid weg; het totaal
 * wordt over het restant verdeeld volgens het gekozen type.
 *
 * **Voorbeeldberekening (AC4.4):** `voorbeeldVerdeling` verdeelt een
 * proefbedrag met de §5.2-verdeler (grootste-restmethode) en toont de
 * per-eenheid-uitkomsten; de som van de delen is exact het proefbedrag.
 *
 * **Historisering (AC4.5):** `nieuweVersie` maakt een nieuwe rij met
 * versie+1 en de nieuwe regels, en zet de oude op `actief = false`.
 * Reeds gegenereerde nota's verwijzen naar de oude sleutel-id en blijven
 * daardoor bewust op de oude versie.
 */

import { and, asc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag, grootsteRestVerdeler } from '@vve/domein';

import { verdeelsleutel, verdeelsleutelRegel } from '../database/schema/verdeelsleutel.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export const SLEUTEL_TYPEN = [
  'breukdeel',
  'vierkante_meters',
  'gelijke_delen',
  'stemmen',
  'handmatig',
] as const;
export type SleutelType = (typeof SLEUTEL_TYPEN)[number];

export interface SleutelRij {
  readonly id: bigint;
  readonly naam: string;
  readonly type: SleutelType;
  readonly versie: number;
  readonly actief: boolean;
  readonly omschrijving: string | null;
}

export interface SleutelMetRegels {
  readonly sleutel: SleutelRij;
  /** Alleen gevuld bij `handmatig` (AC4.2); de afgeleide typen rekenen live. */
  readonly regels: readonly { readonly wooneenheidId: bigint; readonly gewicht: number }[];
}

export interface VoorbeeldRij {
  readonly wooneenheidId: bigint;
  readonly code: string;
  readonly gewicht: number;
  readonly bedragCenten: number;
}

export interface VerdeelsleutelService {
  maak(
    vveId: bigint,
    invoer: {
      naam: string;
      type: SleutelType;
      omschrijving?: string | null;
      regels?: readonly { wooneenheidId: bigint; gewicht: number }[] | null | undefined;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  lijst(vveId: bigint): Promise<readonly SleutelRij[]>;
  detail(vveId: bigint, sleutelId: bigint): Promise<SleutelMetRegels>;
  nieuweVersie(
    vveId: bigint,
    sleutelId: bigint,
    wijziging: {
      naam?: string | null;
      omschrijving?: string | null;
      regels?: readonly { wooneenheidId: bigint; gewicht: number }[] | null | undefined;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  /**
   * AC4.4: de voorbeeldberekening. Werkt voor alle vijf de typen; het
   * proefbedrag is invoer ("€ 12.000 verdeeld → …").
   */
  voorbeeldVerdeling(
    vveId: bigint,
    sleutelId: bigint,
    proefbedrag: Bedrag,
  ): Promise<{ rijen: readonly VoorbeeldRij[]; onverdeeldCenten: number }>;
}

/** Zoekt de gewichten van de sleutel op het moment van verdeling. */
export async function gewichten(
  tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
  vveId: bigint,
  sleutelId: bigint,
): Promise<Map<bigint, number>> {
  const [sleutel] = await tx
    .select()
    .from(verdeelsleutel)
    .where(and(sql`${verdeelsleutel.vveId} = ${vveId}`, sql`${verdeelsleutel.id} = ${sleutelId}`))
    .limit(1);
  if (sleutel === undefined) throw new NietGevondenFout('Verdeelsleutel niet gevonden.');

  // Actieve eenheden van deze VvE (alle bronkolommen voor de afgeleide typen).
  const eenheden = await tx
    .select({
      id: wooneenheid.id,
      breukdeelTeller: wooneenheid.breukdeelTeller,
      oppervlakteM2: wooneenheid.oppervlakteM2,
      stemmen: wooneenheid.stemmen,
    })
    .from(wooneenheid)
    .where(sql`${wooneenheid.vveId} = ${vveId}`)
    .orderBy(asc(wooneenheid.id));

  if (sleutel.type === 'handmatig') {
    const regels = await tx
      .select({
        wooneenheidId: verdeelsleutelRegel.wooneenheidId,
        gewicht: verdeelsleutelRegel.gewicht,
      })
      .from(verdeelsleutelRegel)
      .where(sql`${verdeelsleutelRegel.verdeelsleutelId} = ${sleutelId}`);
    const map = new Map<bigint, number>();
    for (const r of regels) {
      if (r.gewicht > 0) map.set(r.wooneenheidId, r.gewicht);
    }
    return map;
  }

  const map = new Map<bigint, number>();
  for (const e of eenheden) {
    switch (sleutel.type) {
      // Gewicht = teller (de noemer van de VvE is voor de verdeling als
      // schaal onbelangrijk; de verhouding tussen de tellers is het gewicht).
      case 'breukdeel': {
        if (e.breukdeelTeller > 0) map.set(e.id, e.breukdeelTeller);
        break;
      }
      case 'vierkante_meters': {
        const m2 = e.oppervlakteM2 ?? 0;
        if (m2 > 0) map.set(e.id, m2);
        break;
      }
      case 'gelijke_delen': {
        map.set(e.id, 1);
        break;
      }
      case 'stemmen': {
        if (e.stemmen > 0) map.set(e.id, e.stemmen);
        break;
      }
    }
  }
  if (map.size === 0) {
    throw new InvoerFout(
      'Geen enkele eenheid heeft een gewicht voor deze sleutel (alles uitgesloten of leeg).',
    );
  }
  return map;
}

export function maakVerdeelsleutelService(config: {
  readonly db: NodePgDatabase;
}): VerdeelsleutelService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async maak(vveId, invoer, doorPersoonId) {
      const naam = invoer.naam.trim();
      if (naam === '') throw new InvoerFout('Veld "naam" is verplicht.');
      if (!SLEUTEL_TYPEN.includes(invoer.type)) {
        throw new InvoerFout('Onbekend verdeelsleuteltype.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .insert(verdeelsleutel)
          .values({
            vveId,
            naam,
            type: invoer.type,
            omschrijving: invoer.omschrijving ?? null,
          })
          .returning({ id: verdeelsleutel.id });
        if (rij === undefined) throw new Error('verdeelsleutel-insert leverde geen id op');
        if (invoer.type === 'handmatig') {
          if (invoer.regels === undefined || invoer.regels === null || invoer.regels.length === 0) {
            throw new InvoerFout('Een handmatige sleutel heeft ten minste één regel.');
          }
          // De eenheden moeten in deze VvE bestaan; de insert faalt hard op
          // een onbekende FK. Bewust rechtstreeks: de regels zijn de kern
          // van de sleutel, niet een optionele versiering.
          await tx.insert(verdeelsleutelRegel).values(
            invoer.regels.map((r) => ({
              verdeelsleutelId: rij.id,
              wooneenheidId: r.wooneenheidId,
              gewicht: r.gewicht,
            })),
          );
        }
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'verdeelsleutel.aangemaakt',
        categorie: 'financieel',
        onderwerpTabel: 'verdeelsleutel',
        onderwerpId: id,
        details: { naam, type: invoer.type },
      });
      return { id };
    },

    async lijst(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            id: verdeelsleutel.id,
            naam: verdeelsleutel.naam,
            type: verdeelsleutel.type,
            versie: verdeelsleutel.versie,
            actief: verdeelsleutel.actief,
            omschrijving: verdeelsleutel.omschrijving,
          })
          .from(verdeelsleutel)
          .where(sql`${verdeelsleutel.vveId} = ${vveId}`)
          .orderBy(asc(verdeelsleutel.naam), asc(verdeelsleutel.versie));
        return rijen;
      });
    },

    async detail(vveId, sleutelId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [sleutel] = await tx
          .select({
            id: verdeelsleutel.id,
            naam: verdeelsleutel.naam,
            type: verdeelsleutel.type,
            versie: verdeelsleutel.versie,
            actief: verdeelsleutel.actief,
            omschrijving: verdeelsleutel.omschrijving,
          })
          .from(verdeelsleutel)
          .where(
            and(sql`${verdeelsleutel.vveId} = ${vveId}`, sql`${verdeelsleutel.id} = ${sleutelId}`),
          )
          .limit(1);
        if (sleutel === undefined) throw new NietGevondenFout('Verdeelsleutel niet gevonden.');
        const regels = await tx
          .select({
            wooneenheidId: verdeelsleutelRegel.wooneenheidId,
            gewicht: verdeelsleutelRegel.gewicht,
          })
          .from(verdeelsleutelRegel)
          .where(sql`${verdeelsleutelRegel.verdeelsleutelId} = ${sleutelId}`)
          .orderBy(asc(verdeelsleutelRegel.wooneenheidId));
        return {
          sleutel,
          regels: regels.map((r) => ({
            wooneenheidId: r.wooneenheidId,
            gewicht: r.gewicht,
          })),
        };
      });
    },

    /**
     * AC4.5: historisering. De oude rij gaat op `actief = false`; een nieuwe
     * rij met versie+1 erft de naam en — als de aanroeper niets anders
     * opgeeft — de regels van de oude versie. De oude id blijft staan:
     * nota's die naar hem verwijzen blijven bewust op de oude versie.
     */
    async nieuweVersie(vveId, sleutelId, wijziging, doorPersoonId) {
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [oud] = await tx
          .select()
          .from(verdeelsleutel)
          .where(
            and(sql`${verdeelsleutel.vveId} = ${vveId}`, sql`${verdeelsleutel.id} = ${sleutelId}`),
          )
          .limit(1);
        if (oud === undefined) throw new NietGevondenFout('Verdeelsleutel niet gevonden.');

        const [hoogste] = await tx
          .select({ versie: verdeelsleutel.versie })
          .from(verdeelsleutel)
          .where(sql`${verdeelsleutel.vveId} = ${vveId} AND ${verdeelsleutel.naam} = ${oud.naam}`)
          .orderBy(sql`${verdeelsleutel.versie} DESC`)
          .limit(1);
        const versie = (hoogste?.versie ?? 1) + 1;

        // Nieuwe regels: opgegeven regels, of anders een kopie van de oude.
        let regels = wijziging.regels;
        if (regels === undefined || regels === null) {
          const oudeRegels = await tx
            .select({
              wooneenheidId: verdeelsleutelRegel.wooneenheidId,
              gewicht: verdeelsleutelRegel.gewicht,
            })
            .from(verdeelsleutelRegel)
            .where(sql`${verdeelsleutelRegel.verdeelsleutelId} = ${sleutelId}`);
          regels = oudeRegels.map((r) => ({
            wooneenheidId: r.wooneenheidId,
            gewicht: r.gewicht,
          }));
        }

        const [nieuw] = await tx
          .insert(verdeelsleutel)
          .values({
            vveId,
            naam: wijziging.naam?.trim() ?? oud.naam,
            type: oud.type,
            versie,
            actief: true,
            omschrijving: wijziging.omschrijving ?? oud.omschrijving,
          })
          .returning({ id: verdeelsleutel.id });
        if (nieuw === undefined) throw new Error('verdeelsleutel-insert leverde geen id op');

        if (oud.type === 'handmatig') {
          if (regels.length === 0) {
            throw new InvoerFout('Een handmatige sleutel heeft ten minste één regel.');
          }
          await tx.insert(verdeelsleutelRegel).values(
            regels.map((r) => ({
              verdeelsleutelId: nieuw.id,
              wooneenheidId: r.wooneenheidId,
              gewicht: r.gewicht,
            })),
          );
        }

        // De oude versie is definitief: niet meer actief, nooit meer gewijzigd.
        await tx
          .update(verdeelsleutel)
          .set({ actief: false })
          .where(sql`${verdeelsleutel.id} = ${sleutelId}`);
        return nieuw.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'verdeelsleutel.nieuwe_versie',
        categorie: 'financieel',
        onderwerpTabel: 'verdeelsleutel',
        onderwerpId: id,
        details: { vorigeVersie: sleutelId.toString() },
      });
      return { id };
    },

    async voorbeeldVerdeling(vveId, sleutelId, proefbedrag) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const gewichtenMap = await gewichten(tx, vveId, sleutelId);
        const delen = grootsteRestVerdeler.verdeel(proefbedrag, gewichtenMap);

        const codes = await tx
          .select({ id: wooneenheid.id, code: wooneenheid.code })
          .from(wooneenheid)
          .where(sql`${wooneenheid.vveId} = ${vveId}`);
        const codeVan = new Map(codes.map((c) => [c.id, c.code]));

        let som = 0;
        const rijen: VoorbeeldRij[] = [];
        for (const [id, bedrag] of delen) {
          som += bedrag.centen;
          rijen.push({
            wooneenheidId: id,
            code: codeVan.get(id) ?? `#${String(id)}`,
            gewicht: gewichtenMap.get(id) ?? 0,
            bedragCenten: bedrag.centen,
          });
        }
        rijen.sort((a, b) => (a.wooneenheidId < b.wooneenheidId ? -1 : 1));
        // De verdeler garandeert som = totaal; onverdeeld is hier 0 en de
        // toets ernaast bewaakt de garantie van buitenaf (§5.2, tests 1–4).
        return { rijen, onverdeeldCenten: proefbedrag.centen - som };
      });
    },
  };
}
