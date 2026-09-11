/**
 * Bijdrageschema-service — blok G05 (spec §6.5, §5.3, M5 · AC5.2–AC5.5 ·
 * tests #5–#7).
 *
 * Van begroting naar bedrag per eenheid per periode, op drie manieren:
 *
 *   1. `uit_begroting` (§5.3): jaarbedrag(e) = Σ over begrotingsregels r van
 *      verdeel(bedrag_r, sleutel_r)[e]; daarna periodebedrag(e) =
 *      verdeel(jaarbedrag(e), gelijke delen over N perioden) — de tweede
 *      verdeling opnieuw de grootste-restmethode, zodat het verschil van
 *      enkele centen in de eerste maanden valt, niet als sluitpost in december
 *      (§5.3, test #4-geest). Splitsing exploitatie/reserve over de
 *      `is_reservefonds`-vlag van de begrotingsregels (§5.3-tail).
 *
 *   2. `vast_bedrag` (overname): handmatige periodebedragen; het jaarbedrag
 *      wordt daaruit afgeleid. De begroting dient alleen voor dekkingsanalyse:
 *      `dekkingstekort` = begrotingstotaal − som van de jaarbedragen (test #6,
 *      AC5.2-tekst: "dekkingstekort € 1.240 per jaar" — hier in centen).
 *
 *   3. `vierkante_meters` (test #5-geest): totaalbedrag gedeeld door totaal
 *      m², maal m² per eenheid; de verdeling loopt via de §5.2-verdeler met
 *      m² als gewicht — factelijk methode 1 met één regel.
 *
 * **Test #7 (AC5.5):** het schema koppelt de sleutel *van het moment van
 * berekening*: het bewaart alleen de uitkomsten. Reeds gegenereerde nota's
 * (G06) verwijzen naar hun eigen bedragen; een later gewijzigde sleutel
 * verandert een nota nooit met terugwerkende kracht. De statusflow van het
 * schema volgt die van de begroting (zelfde enum).
 */

import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Bedrag, grootsteRestVerdeler } from '@vve/domein';

import { begroting, begrotingsregel } from '../database/schema/begroting.js';
import { bijdrageSchema, bijdrageRegel } from '../database/schema/bijdrage.js';
import { boekjaar } from '../database/schema/boekjaar.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { gewichten } from './verdeelsleutel-service.js';

export interface BijdrageRegelRij {
  readonly wooneenheidId: bigint;
  readonly code: string;
  readonly exploitatieCent: number;
  readonly reservefondsCent: number;
  readonly bron: 'berekend' | 'handmatig';
}

export interface Dekking {
  /** Begrotingstotaal dit jaar. */
  readonly begrotingCenten: number;
  /** Som van de jaarbedragen (periodebedragen × N) van het schema. */
  readonly bijdrageCenten: number;
  /** Positief = dekkingstekort, negatief = overschot (AC5.2-analyse). */
  readonly dekkingsverschilCenten: number;
}

export interface BijdrageOverzicht {
  readonly schema: {
    readonly id: bigint;
    readonly methode: string;
    readonly periodiciteit: string;
    readonly ingangsdatum: string;
    readonly status: string;
  };
  readonly regels: readonly BijdrageRegelRij[];
  /** De totaalsommen over alle eenheden (controle op de begroting). */
  readonly totaalPerPeriodeExploitatieCenten: number;
  readonly totaalPerPeriodeReservefondsCenten: number;
  /** Alleen bij `vast_bedrag`: de AC5.2-dekkingstekort-analyse. */
  readonly dekking: Dekking | null;
}

/** Aantal perioden per jaar voor de periodiciteit (§5.3). */
export function periodenVan(periodiciteit: string): number {
  if (periodiciteit === 'kwartaal') return 4;
  if (periodiciteit === 'jaar') return 1;
  return 12;
}

export interface BijdrageService {
  /** Recomputeert de per-eenheid-bedragen volgens de methode van het schema. */
  herbereken(
    vveId: bigint,
    bijdrageSchemaId: bigint,
    doorPersoonId: bigint,
  ): Promise<{ regels: number; totaalExploitatieCenten: number; totaalReservefondsCenten: number }>;
  /** Vast_bedrag: handmatige periodebedragen per eenheid overschrijven. */
  zetVasteBedragen(
    vveId: bigint,
    bijdrageSchemaId: bigint,
    regels: readonly { wooneenheidId: bigint; exploitatieCent: number; reservefondsCent: number }[],
    doorPersoonId: bigint,
  ): Promise<void>;
  detail(
    vveId: bigint,
    bijdrageSchemaId: bigint,
  ): Promise<{
    schema: {
      id: bigint;
      methode: string;
      periodiciteit: string;
      ingangsdatum: string;
      status: string;
      boekjaarId: bigint;
    };
    regels: readonly BijdrageRegelRij[];
    dekking: Dekking | null;
  }>;
  maak(
    vveId: bigint,
    invoer: {
      boekjaarId: bigint;
      methode: 'uit_begroting' | 'vast_bedrag' | 'vierkante_meters';
      periodiciteit: 'maand' | 'kwartaal' | 'jaar';
      ingangsdatum: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
}

export function maakBijdrageService(config: { readonly db: NodePgDatabase }): BijdrageService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async maak(vveId, invoer, doorPersoonId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoer.ingangsdatum)) {
        throw new InvoerFout('Veld "ingangsdatum" moet de vorm YYYY-MM-DD hebben.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [jaar] = await tx
          .select({ id: boekjaar.id })
          .from(boekjaar)
          .where(sql`${boekjaar.id} = ${invoer.boekjaarId} AND ${boekjaar.vveId} = ${vveId}`)
          .limit(1);
        if (jaar === undefined) throw new NietGevondenFout('Boekjaar niet gevonden.');
        const [rij] = await tx
          .insert(bijdrageSchema)
          .values({
            vveId,
            boekjaarId: invoer.boekjaarId,
            methode: invoer.methode,
            periodiciteit: invoer.periodiciteit,
            ingangsdatum: invoer.ingangsdatum,
          })
          .returning({ id: bijdrageSchema.id });
        if (rij === undefined) throw new Error('bijdrage_schema-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'bijdrage.aangemaakt',
        categorie: 'financieel',
        onderwerpTabel: 'bijdrage_schema',
        onderwerpId: id,
        details: { methode: invoer.methode },
      });
      return { id };
    },

    async herbereken(vveId, bijdrageSchemaId, doorPersoonId) {
      const uitkomst = await inTenantTransactie(db, vveId, async (tx) => {
        const [schema] = await tx
          .select()
          .from(bijdrageSchema)
          .where(
            sql`${bijdrageSchema.vveId} = ${vveId} AND ${bijdrageSchema.id} = ${bijdrageSchemaId}`,
          )
          .limit(1);
        if (schema === undefined) throw new NietGevondenFout('Bijdrageschema niet gevonden.');
        if (schema.status !== 'concept') {
          throw new InvoerFout('Hербerekenen kan alleen zolang het schema concept is.');
        }

        const eenheden = await tx
          .select({
            id: wooneenheid.id,
            code: wooneenheid.code,
            breukdeelTeller: wooneenheid.breukdeelTeller,
            oppervlakteM2: wooneenheid.oppervlakteM2,
            stemmen: wooneenheid.stemmen,
          })
          .from(wooneenheid)
          .where(sql`${wooneenheid.vveId} = ${vveId}`)
          .orderBy(asc(wooneenheid.id));
        if (eenheden.length === 0) {
          throw new InvoerFout('Er zijn nog geen eenheden in deze VvE.');
        }

        const jaarPerEenheid = new Map<bigint, { exploitatie: number; reservefonds: number }>();

        if (schema.methode === 'uit_begroting') {
          // De begroting van dit boekjaar moet bestaan en vastgesteld óf
          // concept zijn (de berekening mag ook vóór vaststelling een
          // proefverdeling leveren — AC5.3 vergelijkt juist op het scherm).
          const [begrotingRij] = await tx
            .select({ id: begroting.id, status: begroting.status })
            .from(begroting)
            .where(
              sql`${begroting.vveId} = ${vveId} AND ${begroting.boekjaarId} = ${schema.boekjaarId}`,
            )
            .limit(1);
          if (begrotingRij === undefined) {
            throw new InvoerFout('Er is nog geen begroting voor dit boekjaar.');
          }
          const regels = await tx
            .select({
              bedragCent: begrotingsregel.bedragCent,
              isReservefonds: begrotingsregel.isReservefonds,
              verdeelsleutelId: begrotingsregel.verdeelsleutelId,
            })
            .from(begrotingsregel)
            .where(sql`${begrotingsregel.begrotingId} = ${begrotingRij.id}`);
          if (regels.length === 0) {
            throw new InvoerFout('De begroting van dit boekjaar heeft geen regels.');
          }

          // Per begrotingsregel: verdeel over de actieve eenheden via de
          // §5.2-verdeler, met de gewichten van G03 (live berekend).
          for (const r of regels) {
            const gewichtenMap = await gewichten(tx, vveId, r.verdeelsleutelId);
            const delen = grootsteRestVerdeler.verdeel(
              Bedrag.vanCenten(r.bedragCent),
              gewichtenMap,
            );
            for (const [eenheidId, bedrag] of delen) {
              const huidig = jaarPerEenheid.get(eenheidId) ?? { exploitatie: 0, reservefonds: 0 };
              if (r.isReservefonds) huidig.reservefonds += bedrag.centen;
              else huidig.exploitatie += bedrag.centen;
              jaarPerEenheid.set(eenheidId, huidig);
            }
          }
        } else if (schema.methode === 'vierkante_meters') {
          // Factelijk methode 1 met één regel: totaal ÷ totaal m² × m² (§5.3-
          // tekst bij methode 3). De totaal-eis: het totaal is hier opgegeven
          // als het exploitatietotaal van de begroting.
          const [begrotingRij] = await tx
            .select({ id: begroting.id })
            .from(begroting)
            .where(
              sql`${begroting.vveId} = ${vveId} AND ${begroting.boekjaarId} = ${schema.boekjaarId}`,
            )
            .limit(1);
          if (begrotingRij === undefined) {
            throw new InvoerFout('Er is nog geen begroting voor dit boekjaar.');
          }
          const [totaal] = await tx
            .select({ som: sql<number>`coalesce(sum(${begrotingsregel.bedragCent}), 0)::int` })
            .from(begrotingsregel)
            .where(sql`${begrotingsregel.begrotingId} = ${begrotingRij.id}`);
          const totaalCenten = totaal?.som ?? 0;
          const m2Map = new Map<bigint, number>();
          for (const e of eenheden) {
            const m2 = e.oppervlakteM2 ?? 0;
            if (m2 > 0) m2Map.set(e.id, m2);
          }
          const delen = grootsteRestVerdeler.verdeel(Bedrag.vanCenten(totaalCenten), m2Map);
          for (const [eenheidId, bedrag] of delen) {
            jaarPerEenheid.set(eenheidId, { exploitatie: bedrag.centen, reservefonds: 0 });
          }
        } else {
          // vast_bedrag: de handmatige regels staan er al (zetVasteBedragen);
          // herbereken is hier een no-op behalve de jaarbedragen afleiden.
          const vaste = await tx
            .select({
              wooneenheidId: bijdrageRegel.wooneenheidId,
              exploitatieCent: bijdrageRegel.exploitatieCent,
              reservefondsCent: bijdrageRegel.reservefondsCent,
            })
            .from(bijdrageRegel)
            .where(sql`${bijdrageRegel.bijdrageSchemaId} = ${bijdrageSchemaId}`);
          for (const r of vaste) {
            jaarPerEenheid.set(r.wooneenheidId, {
              exploitatie: r.exploitatieCent * periodenVan(schema.periodiciteit),
              reservefonds: r.reservefondsCent * periodenVan(schema.periodiciteit),
            });
          }
          if (jaarPerEenheid.size === 0) {
            throw new InvoerFout(
              'Er zijn nog geen vaste bedragen ingevoerd (zetVasteBedragen eerst).',
            );
          }
        }

        // De tweede verdeling (§5.3): jaarbedrag → N perioden. Hier bewaren
        // we het jaarbedrag per eenheid; de periodeverdeling (grootste-rest
        // over N perioden, centen in de eerste maanden) doet G06 bij de
        // nota-generatie. De som over de eenheden == de begroting (AC5.4).
        const nieuweRegels: {
          wooneenheidId: bigint;
          exploitatieCent: number;
          reservefondsCent: number;
        }[] = [];
        for (const [eenheidId, jaar] of jaarPerEenheid) {
          nieuweRegels.push({
            wooneenheidId: eenheidId,
            exploitatieCent: jaar.exploitatie,
            reservefondsCent: jaar.reservefonds,
          });
        }

        // Regels overschrijven (schema is concept; CASCADE-kinderen).
        await tx
          .delete(bijdrageRegel)
          .where(sql`${bijdrageRegel.bijdrageSchemaId} = ${bijdrageSchemaId}`);
        await tx.insert(bijdrageRegel).values(
          nieuweRegels.map((r) => ({
            bijdrageSchemaId: bijdrageSchemaId,
            wooneenheidId: r.wooneenheidId,
            exploitatieCent: r.exploitatieCent,
            reservefondsCent: r.reservefondsCent,
            bron: schema.methode === 'vast_bedrag' ? ('handmatig' as const) : ('berekend' as const),
          })),
        );
        const totaalExploitatie = nieuweRegels.reduce((s, r) => s + r.exploitatieCent, 0);
        const totaalReservefonds = nieuweRegels.reduce((s, r) => s + r.reservefondsCent, 0);
        return {
          regels: nieuweRegels.length,
          totaalExploitatieCenten: totaalExploitatie,
          totaalReservefondsCenten: totaalReservefonds,
        };
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'bijdrage.herberekend',
        categorie: 'financieel',
        onderwerpTabel: 'bijdrage_schema',
        onderwerpId: bijdrageSchemaId,
        details: { ...uitkomst },
      });
      return uitkomst;
    },

    async zetVasteBedragen(vveId, bijdrageSchemaId, regels, doorPersoonId) {
      if (regels.length === 0) throw new InvoerFout('Ten minste één regel is verplicht.');
      await inTenantTransactie(db, vveId, async (tx) => {
        const [schema] = await tx
          .select()
          .from(bijdrageSchema)
          .where(
            sql`${bijdrageSchema.vveId} = ${vveId} AND ${bijdrageSchema.id} = ${bijdrageSchemaId}`,
          )
          .limit(1);
        if (schema === undefined) throw new NietGevondenFout('Bijdrageschema niet gevonden.');
        if (schema.methode !== 'vast_bedrag') {
          throw new InvoerFout('Vaste bedragen horen bij de methode "vast_bedrag".');
        }
        if (schema.status !== 'concept') {
          throw new InvoerFout('Bedragen wijzigen kan alleen zolang het schema concept is.');
        }
        await tx
          .delete(bijdrageRegel)
          .where(sql`${bijdrageRegel.bijdrageSchemaId} = ${bijdrageSchemaId}`);
        await tx.insert(bijdrageRegel).values(
          regels.map((r) => ({
            bijdrageSchemaId,
            wooneenheidId: r.wooneenheidId,
            exploitatieCent: r.exploitatieCent,
            reservefondsCent: r.reservefondsCent,
            bron: 'handmatig' as const,
          })),
        );
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'bijdrage.vaste_bedragen',
          categorie: 'financieel',
          onderwerpTabel: 'bijdrage_schema',
          onderwerpId: bijdrageSchemaId,
          details: { aantalRegels: regels.length },
        });
      });
    },

    async detail(vveId, bijdrageSchemaId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [schema] = await tx
          .select()
          .from(bijdrageSchema)
          .where(
            sql`${bijdrageSchema.vveId} = ${vveId} AND ${bijdrageSchema.id} = ${bijdrageSchemaId}`,
          )
          .limit(1);
        if (schema === undefined) throw new NietGevondenFout('Bijdrageschema niet gevonden.');

        const regels = await tx
          .select({
            wooneenheidId: bijdrageRegel.wooneenheidId,
            code: wooneenheid.code,
            exploitatieCent: bijdrageRegel.exploitatieCent,
            reservefondsCent: bijdrageRegel.reservefondsCent,
            bron: bijdrageRegel.bron,
          })
          .from(bijdrageRegel)
          .innerJoin(wooneenheid, eq(wooneenheid.id, bijdrageRegel.wooneenheidId))
          .where(sql`${bijdrageRegel.bijdrageSchemaId} = ${bijdrageSchemaId}`)
          .orderBy(asc(wooneenheid.code));

        // AC5.2-analyse: bij vast_bedrag de begroting ernaast en het verschil.
        let dekking: Dekking | null = null;
        if (schema.methode === 'vast_bedrag') {
          const [begrotingRij] = await tx
            .select({ id: begroting.id })
            .from(begroting)
            .where(
              sql`${begroting.vveId} = ${vveId} AND ${begroting.boekjaarId} = ${schema.boekjaarId}`,
            )
            .limit(1);
          if (begrotingRij !== undefined) {
            const [totaal] = await tx
              .select({ som: sql<number>`coalesce(sum(${begrotingsregel.bedragCent}), 0)::int` })
              .from(begrotingsregel)
              .where(sql`${begrotingsregel.begrotingId} = ${begrotingRij.id}`);
            const begrotingBedrag = Bedrag.vanCenten(totaal?.som ?? 0);
            const bijdrageBedrag = regels.reduce(
              (s, r) =>
                s.plus(
                  Bedrag.vanCenten(
                    (r.exploitatieCent + r.reservefondsCent) * periodenVan(schema.periodiciteit),
                  ),
                ),
              Bedrag.nul(),
            );
            dekking = {
              begrotingCenten: begrotingBedrag.centen,
              bijdrageCenten: bijdrageBedrag.centen,
              dekkingsverschilCenten: begrotingBedrag.min(bijdrageBedrag).centen,
            };
          }
        }

        return {
          schema: {
            id: schema.id,
            methode: schema.methode,
            periodiciteit: schema.periodiciteit,
            ingangsdatum: schema.ingangsdatum,
            boekjaarId: schema.boekjaarId,
            status: schema.status,
          },
          regels,
          dekking,
        };
      });
    },
  };
}
