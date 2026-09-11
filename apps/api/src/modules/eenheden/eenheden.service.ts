/**
 * Wooneenheden-service — blok V02 (spec M2, §6.4 · AC2.1, AC2.3).
 *
 * De juridische structuur van de VvE: gebouwen (optioneel), wooneenheden
 * (het eigendomsobject) en de eerste koppeling van een eigenaar via
 * `eigenaarschap`. Meerdere eigenaren per eenheid met aandelen en het
 * primaire contact is blok V03; hier bestaat de tabel en kan er precies
 * één eigenaar worden gekoppeld — genoeg voor AC2.1.
 *
 * **Tenant-scoping is hier geen optie (§7.5).** Elke query draait binnen
 * `inTenantTransactie`: één transactie waarin `app.vve_id` is gezet, zodat de
 * RLS-policies uit migratie 0010 zelfstandig meebewaken. De `vveId` die de
 * service krijgt komt uit het access-token (TenantGuard), nooit uit de
 * request-parameters.
 *
 * **AC2.3 — waarschuwen, niet blokkeren.** De som van de breukdelen mag
 * afwijken van de noemer; de lijst toont som, noemer en het verschil. De
 * beheerder beslist of de administratie klopt — een blokkade zou een VvE met
 * een nog niet volledig ingevoerde splitsingsakte onmogelijk maken.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { eigenaarschap } from '../../database/schema/eigenaarschap.js';
import { gebouw } from '../../database/schema/gebouw.js';
import { persoon } from '../../database/schema/persoon.js';
import { rolToewijzing } from '../../database/schema/rol-toewijzing.js';
import { vve } from '../../database/schema/vve.js';
import { wooneenheid } from '../../database/schema/wooneenheid.js';
import { maakAuditService } from '../../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../../gemeenschappelijk/tenant/tenant-context.js';

export const EENHEID_TYPEN = [
  'woning',
  'parkeerplaats',
  'berging',
  'bedrijfsruimte',
  'gemeenschappelijk',
] as const;
export type EenheidTypeKeuze = (typeof EENHEID_TYPEN)[number];

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

export interface EenheidInvoer {
  readonly code: string;
  readonly type?: EenheidTypeKeuze | undefined;
  /** Naam van het gebouw/blok; wordt binnen deze VvE gezocht of aangemaakt. */
  readonly gebouwNaam?: string | undefined;
  readonly straat?: string | undefined;
  readonly huisnummer?: string | undefined;
  readonly huisnummerToevoeging?: string | undefined;
  readonly postcode?: string | undefined;
  readonly plaats?: string | undefined;
  readonly bouwlaag?: number | undefined;
  readonly oppervlakteM2?: number | undefined;
  readonly breukdeelTeller?: number | undefined;
  readonly breukdeelNoemer?: number | undefined;
  readonly stemmen?: number | undefined;
  readonly kadastraleAanduiding?: string | undefined;
  readonly actiefVanaf?: string | undefined;
  readonly actiefTot?: string | undefined;
}

export interface EigenaarKoppeling {
  readonly persoonId: bigint;
  /** 0–1000; default 1000 (volledig eigendom). */
  readonly aandeelPromille: number;
}

export interface EenheidEigenaar {
  readonly persoonId: bigint;
  readonly naam: string;
  readonly aandeelPromille: number;
  readonly isPrimairContact: boolean;
}

export interface EenheidRij {
  readonly id: bigint;
  readonly code: string;
  readonly type: string;
  readonly gebouwNaam: string | null;
  readonly adres: string | null;
  readonly bouwlaag: number | null;
  readonly oppervlakteM2: number | null;
  readonly breukdeelTeller: number;
  readonly breukdeelNoemer: number;
  readonly stemmen: number;
  readonly kadastraleAanduiding: string | null;
  readonly actiefVanaf: string | null;
  readonly actiefTot: string | null;
  readonly eigenaren: readonly EenheidEigenaar[];
}

export interface EenhedenOverzicht {
  readonly eenheden: readonly EenheidRij[];
  readonly gebouwen: readonly {
    readonly id: bigint;
    readonly naam: string;
    readonly adres: string | null;
  }[];
  /** AC2.3: som van de tellers, de noemer van de VvE en het verschil. */
  readonly somTeller: number;
  readonly noemer: number;
  readonly verschil: number;
}

export interface EenhedenService {
  maakEenheid(
    vveId: bigint,
    velden: EenheidInvoer,
    eigenaar: EigenaarKoppeling | null,
  ): Promise<{ eenheidId: bigint }>;
  lijst(vveId: bigint): Promise<EenhedenOverzicht>;
  wijzigEenheid(
    vveId: bigint,
    eenheidId: bigint,
    velden: Partial<EenheidInvoer>,
    doorPersoonId: bigint,
  ): Promise<void>;
}

export interface EenhedenServiceConfig {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
}

// ---------------------------------------------------------------------------
// Validatiehulp — dezelfde stijl als de vve-service (InvoerFout, geen HTTP)
// ---------------------------------------------------------------------------

function verplichteTekst(waarde: unknown, veld: string): string {
  if (typeof waarde !== 'string' || waarde.trim() === '') {
    throw new InvoerFout(`Veld "${veld}" is verplicht.`);
  }
  return waarde.trim();
}

function optioneleTekst(waarde: unknown): string | undefined {
  if (waarde === undefined) return undefined;
  const tekst = typeof waarde === 'string' ? waarde.trim() : '';
  if (tekst === '') return undefined;
  return tekst;
}

function geheelGetal(waarde: unknown, veld: string, minimum: number): number {
  const getal = typeof waarde === 'number' ? waarde : Number(waarde);
  if (!Number.isInteger(getal) || getal < minimum) {
    throw new InvoerFout(`Veld "${veld}" moet een geheel getal ≥ ${String(minimum)} zijn.`);
  }
  return getal;
}

function oppervlakte(waarde: unknown): number | undefined {
  if (waarde === undefined) return undefined;
  const getal = typeof waarde === 'number' ? waarde : Number(waarde);
  if (!Number.isFinite(getal) || getal < 0) {
    throw new InvoerFout('Veld "oppervlakteM2" moet een niet-negatief getal zijn.');
  }
  return getal;
}

/** Kalenderdatum `YYYY-MM-DD` — `date`-kolommen ondergaan nooit tz-conversie. */
function kalenderdatum(waarde: unknown, veld: string): string | undefined {
  const tekst = optioneleTekst(waarde);
  if (tekst === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tekst)) {
    throw new InvoerFout(`Veld "${veld}" moet een datum in de vorm YYYY-MM-DD zijn.`);
  }
  return tekst;
}

function aandeelPromille(waarde: unknown): number {
  const getal = geheelGetal(waarde, 'aandeelPromille', 0);
  if (getal > 1000) {
    throw new InvoerFout('Veld "aandeelPromille" mag hoogstens 1000 (100%) zijn.');
  }
  return getal;
}

function samengesteldeNaam(rij: {
  voornaam: string | null;
  tussenvoegsel: string | null;
  achternaam: string;
}): string {
  return [rij.voornaam, rij.tussenvoegsel, rij.achternaam]
    .filter((deel) => deel !== null && deel !== '')
    .join(' ');
}

/** Is dit een uniek-schending op (vve_id, code)? Dan een leesbare invoerfout. */
function isUniekConflict(fout: unknown): boolean {
  // Drizzle wikkelt driverfouten in een DrizzleQueryError met de oorspronkelijke
  // pg-fout op `cause`; rechtstreeks gezet velt de fout zelf de code dragen.
  const codeVan = (e: unknown): unknown => {
    if (typeof e !== 'object' || e === null) return undefined;
    const kandidaat = e as { code?: unknown; cause?: unknown };
    if (kandidaat.code !== undefined) return kandidaat.code;
    return codeVan(kandidaat.cause);
  };
  return codeVan(fout) === '23505';
}

export function maakEenhedenService(config: EenhedenServiceConfig): EenhedenService {
  const { db, klok } = config;
  const audit = maakAuditService({ db });

  function vandaag(): string {
    return klok.nu().toISOString().slice(0, 10);
  }

  /** Zoekt of maakt het gebouw binnen deze VvE; retourneert zijn id. */
  async function gebouwZoekenAanmaken(
    tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
    vveId: bigint,
    naam: string,
  ): Promise<bigint> {
    const [bestaand] = await tx
      .select({ id: gebouw.id })
      .from(gebouw)
      .where(and(eq(gebouw.vveId, vveId), eq(gebouw.naam, naam)))
      .limit(1);
    if (bestaand !== undefined) return bestaand.id;
    const [nieuw] = await tx.insert(gebouw).values({ vveId, naam }).returning({ id: gebouw.id });
    if (nieuw === undefined) throw new Error('gebouw-insert leverde geen id op');
    return nieuw.id;
  }

  /** Valideert de invoer en bouwt de insert-waarden (zonder vve_id). */
  function eenheidWaarden(velden: Partial<EenheidInvoer>): Record<string, unknown> {
    const uit: Record<string, unknown> = {};
    if (velden.code !== undefined) uit['code'] = verplichteTekst(velden.code, 'code');
    if (velden.type !== undefined) uit['type'] = velden.type;
    for (const sleutel of [
      'straat',
      'huisnummer',
      'huisnummerToevoeging',
      'postcode',
      'plaats',
      'kadastraleAanduiding',
    ] as const) {
      const waarde = optioneleTekst(velden[sleutel]);
      if (waarde !== undefined) uit[sleutel] = waarde;
    }
    if (velden.bouwlaag !== undefined) {
      uit['bouwlaag'] = geheelGetal(velden.bouwlaag, 'bouwlaag', -50);
    }
    if (velden.oppervlakteM2 !== undefined)
      uit['oppervlakteM2'] = oppervlakte(velden.oppervlakteM2);
    if (velden.breukdeelTeller !== undefined) {
      uit['breukdeelTeller'] = geheelGetal(velden.breukdeelTeller, 'breukdeelTeller', 0);
    }
    if (velden.breukdeelNoemer !== undefined) {
      uit['breukdeelNoemer'] = geheelGetal(velden.breukdeelNoemer, 'breukdeelNoemer', 1);
    }
    if (velden.stemmen !== undefined) {
      uit['stemmen'] = geheelGetal(velden.stemmen, 'stemmen', 0);
    }
    const vanaf = kalenderdatum(velden.actiefVanaf, 'actiefVanaf');
    if (vanaf !== undefined) uit['actiefVanaf'] = vanaf;
    const tot = kalenderdatum(velden.actiefTot, 'actiefTot');
    if (tot !== undefined) uit['actiefTot'] = tot;
    return uit;
  }

  return {
    async maakEenheid(vveId, velden, eigenaar) {
      const code = verplichteTekst(velden.code, 'code');
      const teller = geheelGetal(velden.breukdeelTeller ?? 1, 'breukdeelTeller', 0);
      const noemer = geheelGetal(velden.breukdeelNoemer ?? 1000, 'breukdeelNoemer', 1);
      if (teller > noemer) {
        throw new InvoerFout('Het breukdeel (teller) kan niet groter zijn dan de noemer.');
      }
      // AC2.4-deel (V03 bouwt hierop): het aandeel van de gekoppelde eigenaar.
      const aandeel = eigenaar === null ? 1000 : aandeelPromille(eigenaar.aandeelPromille);

      const eenheidId = await inTenantTransactie(db, vveId, async (tx) => {
        // Het gebouw hoort bij dezelfde VvE: binnen deze transactie zoeken
        // (RLS ziet sowieso alleen rijen van deze tenant), anders aanmaken.
        let gebouwId: bigint | null = null;
        const gebouwNaam = optioneleTekst(velden.gebouwNaam);
        if (gebouwNaam !== undefined) {
          gebouwId = await gebouwZoekenAanmaken(tx, vveId, gebouwNaam);
        }

        const [rij] = await tx
          .insert(wooneenheid)
          .values({
            vveId,
            ...(gebouwId !== null ? { gebouwId } : {}),
            code,
            ...eenheidWaarden(velden),
            breukdeelTeller: teller,
            breukdeelNoemer: noemer,
          })
          .returning({ id: wooneenheid.id })
          .catch((fout: unknown) => {
            if (isUniekConflict(fout)) {
              throw new InvoerFout(`Er bestaat al een eenheid met code "${code}" in deze VvE.`);
            }
            throw fout;
          });
        if (rij === undefined) throw new Error('wooneenheid-insert leverde geen id op');

        if (eigenaar !== null) {
          // AC2.1: de eerste eenheid van de beheerder koppelt hem automatisch
          // als eigenaar. Periode vanaf vandaag, onbegrensd naar voren.
          await tx.insert(eigenaarschap).values({
            vveId,
            wooneenheidId: rij.id,
            persoonId: eigenaar.persoonId,
            aandeelPromille: aandeel,
            // De eerste (en voorlopig enige) eigenaar is het primaire contact.
            isPrimairContact: true,
            periode: `[${vandaag()},)`,
          });
        }
        return rij.id;
      });

      await audit.registreer({
        vveId,
        persoonId: eigenaar?.persoonId ?? null,
        gebeurtenis: 'eenheid.aanmaken',
        categorie: 'app',
        onderwerpTabel: 'wooneenheid',
        onderwerpId: eenheidId,
        details: { code },
      });
      return { eenheidId };
    },

    async lijst(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            id: wooneenheid.id,
            code: wooneenheid.code,
            type: wooneenheid.type,
            gebouwNaam: gebouw.naam,
            straat: wooneenheid.straat,
            huisnummer: wooneenheid.huisnummer,
            huisnummerToevoeging: wooneenheid.huisnummerToevoeging,
            postcode: wooneenheid.postcode,
            plaats: wooneenheid.plaats,
            bouwlaag: wooneenheid.bouwlaag,
            oppervlakteM2: wooneenheid.oppervlakteM2,
            breukdeelTeller: wooneenheid.breukdeelTeller,
            breukdeelNoemer: wooneenheid.breukdeelNoemer,
            stemmen: wooneenheid.stemmen,
            kadastraleAanduiding: wooneenheid.kadastraleAanduiding,
            actiefVanaf: wooneenheid.actiefVanaf,
            actiefTot: wooneenheid.actiefTot,
          })
          .from(wooneenheid)
          .leftJoin(gebouw, eq(gebouw.id, wooneenheid.gebouwId))
          .where(eq(wooneenheid.vveId, vveId))
          .orderBy(asc(wooneenheid.code));

        // Actuele eigenaren in één slag (geen N+1): periode bevat vandaag.
        const eigenaren = await tx
          .select({
            wooneenheidId: eigenaarschap.wooneenheidId,
            persoonId: persoon.id,
            voornaam: persoon.voornaam,
            tussenvoegsel: persoon.tussenvoegsel,
            achternaam: persoon.achternaam,
            aandeelPromille: eigenaarschap.aandeelPromille,
            isPrimairContact: eigenaarschap.isPrimairContact,
          })
          .from(eigenaarschap)
          .innerJoin(persoon, eq(persoon.id, eigenaarschap.persoonId))
          .where(sql`${eigenaarschap.periode} @> CURRENT_DATE`);

        const gebouwenRijen = await tx
          .select({ id: gebouw.id, naam: gebouw.naam, adres: gebouw.adres })
          .from(gebouw)
          .where(eq(gebouw.vveId, vveId))
          .orderBy(asc(gebouw.naam));

        const [telling] = await tx
          .select({ som: sql<number>`coalesce(sum(${wooneenheid.breukdeelTeller}), 0)::int` })
          .from(wooneenheid)
          .where(eq(wooneenheid.vveId, vveId));

        const [vveRij] = await tx
          .select({ noemer: vve.breukdeelNoemer })
          .from(vve)
          .where(eq(vve.id, vveId))
          .limit(1);
        if (vveRij === undefined) throw new NietGevondenFout('VvE niet gevonden.');

        const somTeller = telling?.som ?? 0;
        const noemer = vveRij.noemer;
        return {
          eenheden: rijen.map((r) => ({
            id: r.id,
            code: r.code,
            type: r.type,
            gebouwNaam: r.gebouwNaam ?? null,
            adres:
              [r.straat, [r.huisnummer, r.huisnummerToevoeging].filter(Boolean).join('')]
                .filter((deel) => deel !== null && deel !== '')
                .join(' ') || null,
            bouwlaag: r.bouwlaag,
            oppervlakteM2: r.oppervlakteM2 === null ? null : r.oppervlakteM2,
            breukdeelTeller: r.breukdeelTeller,
            breukdeelNoemer: r.breukdeelNoemer,
            stemmen: r.stemmen,
            kadastraleAanduiding: r.kadastraleAanduiding,
            actiefVanaf: r.actiefVanaf,
            actiefTot: r.actiefTot,
            eigenaren: eigenaren
              .filter((e) => e.wooneenheidId === r.id)
              .map((e) => ({
                persoonId: e.persoonId,
                naam: samengesteldeNaam(e),
                aandeelPromille: e.aandeelPromille,
                isPrimairContact: e.isPrimairContact,
              })),
          })),
          gebouwen: gebouwenRijen,
          somTeller,
          noemer,
          verschil: noemer - somTeller,
        };
      });
    },

    async wijzigEenheid(vveId, eenheidId, velden, doorPersoonId) {
      const waarden = eenheidWaarden(velden);
      const gebouwNaam = optioneleTekst(velden.gebouwNaam);
      if (Object.keys(waarden).length === 0 && gebouwNaam === undefined) return;

      await inTenantTransactie(db, vveId, async (tx) => {
        let gebouwId: bigint | null | undefined;
        if (gebouwNaam !== undefined) {
          gebouwId = await gebouwZoekenAanmaken(tx, vveId, gebouwNaam);
        }
        const rijen = await tx
          .update(wooneenheid)
          .set({
            ...waarden,
            ...(gebouwId !== undefined && gebouwId !== null ? { gebouwId } : {}),
            gewijzigdOp: klok.nu(),
          })
          .where(and(eq(wooneenheid.id, eenheidId), eq(wooneenheid.vveId, vveId)))
          .returning({ id: wooneenheid.id });
        if (rijen.length === 0) {
          throw new NietGevondenFout('Wooneenheid niet gevonden in deze VvE.');
        }
        const code = typeof waarden['code'] === 'string' ? waarden['code'] : undefined;
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'eenheid.wijzigen',
          categorie: 'app',
          onderwerpTabel: 'wooneenheid',
          onderwerpId: rijen[0]?.id ?? null,
          ...(code !== undefined ? { details: { code } } : {}),
        });
      });
    },
  };
}

/**
 * Heeft deze persoon een lopende rol in deze VvE? Gebruikt door de controller
 * als dubbele deur naast de TenantGuard (§7.5: de rol wordt tegen de database
 * van het moment gecontroleerd, niet tegen het token).
 */
export async function heeftRolInVve(
  db: NodePgDatabase,
  persoonId: bigint,
  vveId: bigint,
): Promise<boolean> {
  const [rij] = await db
    .select({ id: rolToewijzing.id })
    .from(rolToewijzing)
    .where(
      and(
        eq(rolToewijzing.vveId, vveId),
        eq(rolToewijzing.persoonId, persoonId),
        sql`${rolToewijzing.eindDatum} IS NULL`,
      ),
    )
    .limit(1);
  return rij !== undefined;
}
