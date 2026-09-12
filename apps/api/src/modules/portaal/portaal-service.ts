/**
 * Portaal-service — blok V07 (spec M14 · AC14.1–14.3).
 *
 * De API achter het eigenaarsportaal. Twee handelingen:
 *
 * **Overzicht (`overzicht`)** — alles voor het startscherm in één call:
 * de eenheden waar de opvrager nu eigenaar van is (met aandeel en breukdeel),
 * per eenheid het openstaande saldo (G06/G08-data, live gerekend) en de
 * laatste betalingen (G08), plus de laatste mededelingen van de VvE (M13).
 * Alles via de bestaande services/tabellen — het portaal is een leesvenster,
 * geen nieuwe bron van waarheid.
 *
 * **Eigen gegevens wijzigen (`wijzigGegevens`)** — AC14.3: voornaam,
 * tussenvoegsel, achternaam, telefoon, correspondentieadres en
 * communicatievoorkeur zelf wijzigen. De achternaam kan alleen leeg-blanken
 * worden geweigerd (NOT NULL in de db). **E-mail wijzigen hoort hier bewust
 * níet bij:** de spec eist verificatie van het nieuwe adres; dat is een eigen
 * flow (opak token naar het nieuwe adres) en hoort bij het blok dat die
 * verificatie uitwerkt — niet als stil side-effect in het profiel.
 *
 * **Toegang:** het overzicht draait binnen `inTenantTransactie` op de
 * actieve VvE; alleen de eenheden waar de opvrager *zelf* een lopende
 * eigenaarsperiode heeft, komen terug — de RLS-filtert niet op persoon, dat
 * doet de query (eigenaar-zicht, geen bestuur-zicht).
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { eigenaarschap } from '../../database/schema/eigenaarschap.js';
import { mededeling } from '../../database/schema/mededeling.js';
import { nota } from '../../database/schema/nota.js';
import { persoon } from '../../database/schema/persoon.js';
import { betaling } from '../../database/schema/betaling.js';
import { wooneenheid } from '../../database/schema/wooneenheid.js';
import { maakAuditService } from '../../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from '../../financieel/boekhouding.js';

const COMMUNICATIE_WIJZEN = ['email', 'post', 'beide'] as const;

export interface PortaalEenheid {
  readonly eenheidId: bigint;
  readonly code: string;
  readonly type: string;
  readonly oppervlakteM2: number | null;
  readonly breukdeelTeller: number;
  readonly breukdeelNoemer: number;
  readonly aandeelPromille: number;
  readonly isPrimairContact: boolean;
  readonly sinds: string;
  /** Openstaande nota's op deze eenheid (G06, live gerekend). */
  readonly openstaandCenten: number;
  readonly oudsteVervaldatum: string | null;
  /** Creditsaldo: betaald maar nog niet gekoppeld (G08, live gerekend). */
  readonly creditSaldoCenten: number;
}

export interface PortaalBetaling {
  readonly id: bigint;
  readonly datum: string;
  readonly bedragCent: number;
  readonly bron: string;
  readonly omschrijving: string | null;
  readonly gekoppeldCenten: number;
}

export interface PortaalMededeling {
  readonly id: bigint;
  readonly titel: string;
  readonly inhoud: string;
  readonly doelgroep: string;
  readonly gepubliceerdOp: string;
}

export interface PortaalOverzicht {
  readonly vveId: bigint;
  readonly eenheden: readonly PortaalEenheid[];
  readonly betalingen: readonly PortaalBetaling[];
  readonly mededelingen: readonly PortaalMededeling[];
}

export interface PortaalGegevens {
  readonly persoonId: bigint;
  readonly email: string;
  readonly voornaam: string | null;
  readonly tussenvoegsel: string | null;
  readonly achternaam: string;
  readonly telefoon: string | null;
  readonly corrStraat: string | null;
  readonly corrHuisnummer: string | null;
  readonly corrPostcode: string | null;
  readonly corrPlaats: string | null;
  readonly communicatieWijze: string;
}

export interface PortaalService {
  overzicht(vveId: bigint, persoonId: bigint): Promise<PortaalOverzicht>;
  gegevens(persoonId: bigint): Promise<PortaalGegevens>;
  wijzigGegevens(
    persoonId: bigint,
    invoer: {
      voornaam?: string;
      tussenvoegsel?: string;
      achternaam?: string;
      telefoon?: string;
      corrStraat?: string;
      corrHuisnummer?: string;
      corrPostcode?: string;
      corrPlaats?: string;
      communicatieWijze?: string;
    },
  ): Promise<PortaalGegevens>;
}

export function maakPortaalService(config: { readonly db: NodePgDatabase }): PortaalService {
  const { db } = config;
  const audit = maakAuditService({ db });

  /** Kort tekstveld trimmen; leeg wordt undefined (kolom mag NULL zijn). */
  function optioneel(waarde: string | undefined): string | undefined {
    if (waarde === undefined) return undefined;
    const tekst = waarde.trim();
    return tekst === '' ? undefined : tekst;
  }

  return {
    async overzicht(vveId, persoonId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        // Mijn lopende eigenaarschappen op deze VvE, met de eenheid erbij.
        const rijen = await tx
          .select({
            eenheidId: wooneenheid.id,
            code: wooneenheid.code,
            type: wooneenheid.type,
            oppervlakteM2: wooneenheid.oppervlakteM2,
            breukdeelTeller: wooneenheid.breukdeelTeller,
            breukdeelNoemer: wooneenheid.breukdeelNoemer,
            aandeel: eigenaarschap.aandeelPromille,
            primair: eigenaarschap.isPrimairContact,
            sinds: eigenaarschap.periode,
          })
          .from(eigenaarschap)
          .innerJoin(wooneenheid, eq(wooneenheid.id, eigenaarschap.wooneenheidId))
          .where(
            and(
              eq(eigenaarschap.vveId, vveId),
              eq(eigenaarschap.persoonId, persoonId),
              sql`${eigenaarschap.periode} @> current_date`,
            ),
          )
          .orderBy(wooneenheid.code);

        // Per eenheid: openstaande nota's + creditsaldo (G06/G08-data, live).
        const eenheden: PortaalEenheid[] = [];
        for (const r of rijen) {
          const [openstaand] = await tx
            .select({
              totaal: sql<number>`COALESCE(SUM(CASE WHEN ${nota.status} IN ('open', 'deels_betaald') THEN ${nota.openstaandCent} ELSE 0 END), 0)::int`,
              oudste: sql<
                string | null
              >`MIN(CASE WHEN ${nota.status} IN ('open', 'deels_betaald') THEN ${nota.vervaldatum} END)`,
            })
            .from(nota)
            .where(eq(nota.wooneenheidId, r.eenheidId));
          const [saldo] = await tx
            .select({
              betaald: sql<number>`COALESCE(SUM(${betaling.bedragCent}), 0)::int`,
            })
            .from(betaling)
            .where(eq(betaling.wooneenheidId, r.eenheidId));
          const [gekoppeld] = await tx
            .select({
              som: sql<number>`COALESCE(SUM(${sql.raw('k.bedrag_cent')}), 0)::int`,
            })
            .from(sql`betaling_koppeling k`)
            .where(
              sql`k.betaling_id IN (SELECT id FROM betaling WHERE wooneenheid_id = ${r.eenheidId})`,
            );
          const start = r.sinds.substring(1, 11);
          eenheden.push({
            eenheidId: r.eenheidId,
            code: r.code,
            type: r.type,
            oppervlakteM2: r.oppervlakteM2,
            breukdeelTeller: r.breukdeelTeller,
            breukdeelNoemer: r.breukdeelNoemer,
            aandeelPromille: r.aandeel,
            isPrimairContact: r.primair,
            sinds: start,
            openstaandCenten: openstaand?.totaal ?? 0,
            oudsteVervaldatum: openstaand?.oudste ?? null,
            creditSaldoCenten: Math.max(0, (saldo?.betaald ?? 0) - (gekoppeld?.som ?? 0)),
          });
        }

        // Laatste betalingen van de eigenaar (via zijn eenheden), nieuwste eerst.
        const eenheidIds = rijen.map((r) => r.eenheidId);
        const betalingen: PortaalBetaling[] =
          eenheidIds.length === 0
            ? []
            : (
                await tx
                  .select({
                    id: betaling.id,
                    datum: betaling.datum,
                    bedragCent: betaling.bedragCent,
                    bron: betaling.bron,
                    omschrijving: betaling.omschrijving,
                    gekoppeld: sql<number>`(
                      SELECT COALESCE(SUM(k.bedrag_cent), 0)::int
                        FROM betaling_koppeling k
                       WHERE k.betaling_id = ${betaling.id}
                    )`,
                  })
                  .from(betaling)
                  .where(
                    and(
                      eq(betaling.vveId, vveId),
                      sql`${betaling.wooneenheidId} = ANY(${sql.raw(`ARRAY[${eenheidIds.join(',')}]::bigint[]`)})`,
                    ),
                  )
                  .orderBy(desc(betaling.datum), desc(betaling.id))
                  .limit(10)
              ).map((b) => ({
                id: b.id,
                datum: b.datum,
                bedragCent: b.bedragCent,
                bron: b.bron,
                omschrijving: b.omschrijving,
                gekoppeldCenten: b.gekoppeld,
              }));

        // Laatste mededelingen van de VvE (M13-leesvenster).
        const mededelingen = (
          await tx
            .select({
              id: mededeling.id,
              titel: mededeling.titel,
              inhoud: mededeling.inhoud,
              doelgroep: mededeling.doelgroep,
              gepubliceerdOp: mededeling.gepubliceerdOp,
            })
            .from(mededeling)
            .where(eq(mededeling.vveId, vveId))
            .orderBy(desc(mededeling.gepubliceerdOp))
            .limit(5)
        ).map((m) => ({
          id: m.id,
          titel: m.titel,
          inhoud: m.inhoud,
          doelgroep: m.doelgroep,
          gepubliceerdOp: m.gepubliceerdOp.toISOString().slice(0, 10),
        }));

        return { vveId, eenheden, betalingen, mededelingen };
      });
    },

    async gegevens(persoonId) {
      const [rij] = await db
        .select({
          persoonId: persoon.id,
          email: persoon.email,
          voornaam: persoon.voornaam,
          tussenvoegsel: persoon.tussenvoegsel,
          achternaam: persoon.achternaam,
          telefoon: persoon.telefoon,
          corrStraat: persoon.corrStraat,
          corrHuisnummer: persoon.corrHuisnummer,
          corrPostcode: persoon.corrPostcode,
          corrPlaats: persoon.corrPlaats,
          communicatieWijze: persoon.communicatieWijze,
        })
        .from(persoon)
        .where(eq(persoon.id, persoonId))
        .limit(1);
      if (rij === undefined) throw new NietGevondenFout('Persoon niet gevonden.');
      return rij;
    },

    async wijzigGegevens(persoonId, invoer) {
      // De velden die er zijn worden bijgewerkt; onbekende/lege optionele
      // velden worden undefined geweigerd door de exactOptionalPropertyTypes-
      // discipline: hier bouwen we de update expliciet op.
      const update: Record<string, unknown> = {};
      if (invoer.voornaam !== undefined) update['voornaam'] = optioneel(invoer.voornaam) ?? null;
      if (invoer.tussenvoegsel !== undefined) {
        update['tussenvoegsel'] = optioneel(invoer.tussenvoegsel) ?? null;
      }
      if (invoer.achternaam !== undefined) {
        const achternaam = invoer.achternaam.trim();
        if (achternaam === '') throw new InvoerFout('De achternaam mag niet leeg zijn.');
        update['achternaam'] = achternaam;
      }
      if (invoer.telefoon !== undefined) update['telefoon'] = optioneel(invoer.telefoon) ?? null;
      if (invoer.corrStraat !== undefined) {
        update['corrStraat'] = optioneel(invoer.corrStraat) ?? null;
      }
      if (invoer.corrHuisnummer !== undefined) {
        update['corrHuisnummer'] = optioneel(invoer.corrHuisnummer) ?? null;
      }
      if (invoer.corrPostcode !== undefined) {
        update['corrPostcode'] = optioneel(invoer.corrPostcode) ?? null;
      }
      if (invoer.corrPlaats !== undefined) {
        update['corrPlaats'] = optioneel(invoer.corrPlaats) ?? null;
      }
      if (invoer.communicatieWijze !== undefined) {
        if (!(COMMUNICATIE_WIJZEN as readonly string[]).includes(invoer.communicatieWijze)) {
          throw new InvoerFout('communicatieWijze moet "email", "post" of "beide" zijn.');
        }
        update['communicatieWijze'] = invoer.communicatieWijze;
      }
      const sleutels = Object.keys(update);
      if (sleutels.length === 0) {
        throw new InvoerFout('Er is niets te wijzigen: geef minstens één veld op.');
      }

      const [na] = await db.update(persoon).set(update).where(eq(persoon.id, persoonId)).returning({
        persoonId: persoon.id,
        email: persoon.email,
        voornaam: persoon.voornaam,
        tussenvoegsel: persoon.tussenvoegsel,
        achternaam: persoon.achternaam,
        telefoon: persoon.telefoon,
        corrStraat: persoon.corrStraat,
        corrHuisnummer: persoon.corrHuisnummer,
        corrPostcode: persoon.corrPostcode,
        corrPlaats: persoon.corrPlaats,
        communicatieWijze: persoon.communicatieWijze,
      });
      if (na === undefined) throw new NietGevondenFout('Persoon niet gevonden.');

      await audit.registreer({
        vveId: null,
        persoonId,
        gebeurtenis: 'profiel.gegevens_gewijzigd',
        categorie: 'app',
        onderwerpTabel: 'persoon',
        onderwerpId: persoonId,
        details: { velden: sleutels },
      });
      return na;
    },
  };
}
