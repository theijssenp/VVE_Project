/**
 * Import-service — blok V06 (spec M2 · AC2.7).
 *
 * Bulk-import van eenheden en eigenaren via CSV/XLSX. De stappen per
 * import-verzoek:
 *   1. **Validatie vooraf** — kolomnamen toetsen op verplichte koppen,
 *      elke rij velden toetsen (code, type, breukdeel, e-mailvorm, aandeel)
 *      *zonder* iets te schrijven.
 *   2. **Dry-run-rapport** — de uitkomst als de import zou slagen: per rij
 *      wat er gebeurt (aanmaken / koppelen / uitnodiging sturen), met de
 *      fouten die hij zó weigeren zou. Zonder `uitvoeren` is dit het
 *      antwoord — de beheerder kijkt en kiest.
 *   3. **Uitvoeren** (alleen op expliciet verzoek, met dezelfde invoer):
 *      eenheden die al bestaan (code) worden bij hun code hergebruikt,
 *      bestaande personen (e-mail) direct gekoppeld (§3.3-patroon), nieuwe
 *      adressen krijgen een uitnodiging via de V04-flow. Idempotent: een
 *      tweede run levert hetzelfde rapport zonder dubbele rijen.
 *
 * **Geen personen aangemaakt door de import.** De import leest e-mailadres,
 * naam en rol; wie het adres nog niet heeft, krijgt de gewone uitnodiging
 * met opak token (V04) — het token ís de autorisatie, niet een voorgecreëerde
 * persoon-rij met wachtwoord die niemand bezit. Zo blijft de registratie-
 * flow (F06) de enige plek waar personen met wachtwoorden ontstaan.
 *
 * **Voorbeeldbestand:** `voorbeeldCsv()` levert het CSV-voorbeeld met alle
 * kolommen in de verwachte volgorde — hetzelfde model dat de parser leest
 * (AC2.7 "met voorbeeldbestand").
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';

import { eigenaarschap } from '../../database/schema/eigenaarschap.js';
import { persoon } from '../../database/schema/persoon.js';
import { uitnodiging } from '../../database/schema/uitnodiging.js';
import { wooneenheid } from '../../database/schema/wooneenheid.js';
import { maakAuditService } from '../../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout } from './eenheden.service.js';
import { parseTabel, type GeparseerdeTabel } from './tabel-lezer.js';

/** De verwachte kolommen (AC2.7). Code is de sleutel; de rest is optioneel. */
export const IMPORT_KOLOMMEN = [
  'code',
  'type',
  'gebouw',
  'straat',
  'huisnummer',
  'postcode',
  'plaats',
  'oppervlakte_m2',
  'breukdeel_teller',
  'breukdeel_noemer',
  'stemmen',
  'eigenaar_email',
  'eigenaar_voornaam',
  'eigenaar_tussenvoegsel',
  'eigenaar_achternaam',
  'eigenaar_aandeel_promille',
] as const;

const EENHEID_TYPEN = [
  'woning',
  'parkeerplaats',
  'berging',
  'bedrijfsruimte',
  'gemeenschappelijk',
] as const;

export interface ImportRijUitslag {
  readonly regel: number;
  readonly code: string;
  readonly eigenaarEmail: string;
  readonly actie:
    | 'eenheid_aanmaken'
    | 'eenheid_bestaat_al'
    | 'eigenaar_koppelen'
    | 'uitnodiging_sturen'
    | 'geen_eigenaar';
  readonly waarschuwing: string | null;
  readonly fout: string | null;
}

export interface ImportRapport {
  readonly formaat: 'csv' | 'xlsx';
  readonly kolommenOk: boolean;
  readonly mistKolommen: readonly string[];
  readonly totaalRijen: number;
  readonly geldig: number;
  readonly ongeldig: number;
  readonly rijen: readonly ImportRijUitslag[];
  readonly uitgevoerd: boolean;
  readonly aangemaakteEenheden: number;
  readonly gekoppeldeEigenaren: number;
  readonly gestuurdeUitnodigingen: number;
}

export interface ImportService {
  /** Het voorbeeldbestand (AC2.7): dezelfde kolommen die de import leest. */
  voorbeeldCsv(): string;
  /** Validatie + (dry-run-)rapport; schrijft niets tenzij `uitvoeren`. */
  verwerk(
    vveId: bigint,
    bestand: { bytes: Buffer; uitvoeren: boolean },
    doorPersoonId: bigint,
  ): Promise<ImportRapport>;
}

export function maakImportService(config: {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
  /** Basis-URL van de registratiepagina (voor de uitnodigingslink in de mail). */
  readonly registratieBasis: string;
  /** De mailverzender uit F10; de import stuurt zijn eigen meldingen. */
  readonly verzendMail: (aan: string, onderwerp: string, tekst: string) => Promise<void>;
}): ImportService {
  const { db, klok, registratieBasis, verzendMail } = config;
  const audit = maakAuditService({ db });

  function vandaag(): string {
    const dag = klok.vandaag();
    const maand = String(dag.maand).padStart(2, '0');
    const dagS = String(dag.dag).padStart(2, '0');
    return `${String(dag.jaar)}-${maand}-${dagS}`;
  }

  /** De koppen-toets: verplichte kolommen moeten er zijn (AC2.7). */
  function koppenToetsen(tabel: GeparseerdeTabel): readonly string[] {
    const aanwezig = new Set(tabel.koppen.map((k) => k.trim().toLowerCase()));
    return IMPORT_KOLOMMEN.filter((kolom) => !aanwezig.has(kolom));
  }

  /** Celwaarde uit de rij; lege waarden zijn undefined. */
  function cel(rij: readonly (readonly [string, string])[], kolom: string): string | undefined {
    const paar = rij.find(([k]) => k === kolom);
    const waarde = paar?.[1].trim();
    return waarde === '' || waarde === undefined ? undefined : waarde;
  }

  /** De veldtoetsen van één rij — fouten verzamelen i.p.v. eerste gooien. */
  function toetsRij(rij: readonly (readonly [string, string])[]): {
    code: string | null;
    eigenaarEmail: string;
    actie: ImportRijUitslag['actie'];
    waarschuwing: string | null;
    fout: string | null;
  } {
    const code = cel(rij, 'code');
    if (code === undefined) {
      return {
        code: null,
        eigenaarEmail: '',
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: 'Kolom "code" is verplicht.',
      };
    }
    const type = cel(rij, 'type') ?? 'woning';
    if (!(EENHEID_TYPEN as readonly string[]).includes(type)) {
      return {
        code,
        eigenaarEmail: '',
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: `Onbekend type "${type}".`,
      };
    }
    const tellerTekst = cel(rij, 'breukdeel_teller');
    const noemerTekst = cel(rij, 'breukdeel_noemer');
    const teller = tellerTekst === undefined ? 1 : Number(tellerTekst);
    const noemer = noemerTekst === undefined ? 1000 : Number(noemerTekst);
    if (!Number.isInteger(teller) || teller < 0) {
      return {
        code,
        eigenaarEmail: '',
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: 'breukdeel_teller moet een geheel getal ≥ 0 zijn.',
      };
    }
    if (!Number.isInteger(noemer) || noemer <= 0) {
      return {
        code,
        eigenaarEmail: '',
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: 'breukdeel_noemer moet een geheel getal > 0 zijn.',
      };
    }
    if (teller > noemer) {
      return {
        code,
        eigenaarEmail: '',
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: 'Het breukdeel (teller) kan niet groter zijn dan de noemer.',
      };
    }
    const oppervlakteTekst = cel(rij, 'oppervlakte_m2');
    if (oppervlakteTekst !== undefined) {
      const oppervlakte = Number(oppervlakteTekst.replace(',', '.'));
      if (!Number.isFinite(oppervlakte) || oppervlakte < 0) {
        return {
          code,
          eigenaarEmail: '',
          actie: 'geen_eigenaar',
          waarschuwing: null,
          fout: 'oppervlakte_m2 moet een niet-negatief getal zijn.',
        };
      }
    }

    const email = cel(rij, 'eigenaar_email');
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        code,
        eigenaarEmail: email,
        actie: 'geen_eigenaar',
        waarschuwing: null,
        fout: `Geen geldig e-mailadres: "${email}".`,
      };
    }

    const aandeelTekst = cel(rij, 'eigenaar_aandeel_promille');
    if (aandeelTekst !== undefined) {
      const aandeel = Number(aandeelTekst);
      if (!Number.isInteger(aandeel) || aandeel <= 0 || aandeel > 1000) {
        return {
          code,
          eigenaarEmail: email ?? '',
          actie: 'geen_eigenaar',
          waarschuwing: null,
          fout: 'eigenaar_aandeel_promille moet tussen 1 en 1000 liggen.',
        };
      }
    }

    // AC2.3-geest: de breukdelen hoeven niet op te gaan — de lijst toont
    // het verschil; hier alleen de waarschuwing, geen weigering.
    let waarschuwing: string | null = null;
    if (tellerTekst !== undefined && noemerTekst !== undefined && teller !== noemer) {
      waarschuwing = 'Het breukdeel is geen 1/noemer — controleer de som over alle eenheden.';
    }

    const actie: ImportRijUitslag['actie'] =
      email === undefined ? 'geen_eigenaar' : 'uitnodiging_sturen';
    return { code, eigenaarEmail: email ?? '', actie, waarschuwing, fout: null };
  }

  return {
    voorbeeldCsv() {
      const kop = IMPORT_KOLOMMEN.join(';');
      const rijen = [
        'A-01;woning;;Kerkstraat 1;1;1011AB;Amsterdam;85,5;1;1000;1;jan@example.nl;Jan;;Jansen;1000',
        'A-02;woning;;Kerkstraat 3;3;1011AB;Amsterdam;85,5;1;1000;1;anouk@example.nl;Anouk;;de Vries;500',
      ].join('\n');
      return `${kop}\n${rijen}\n`;
    },

    async verwerk(vveId, bestand, doorPersoonId) {
      const tabel = parseTabel(bestand.bytes);
      const formaat = bestand.bytes.subarray(0, 2).toString('latin1') === 'PK' ? 'xlsx' : 'csv';
      const mistKolommen = koppenToetsen(tabel);
      const kolommenOk = mistKolommen.length === 0;

      // Validatie per rij (zonder te schrijven).
      const uitslagen: ImportRijUitslag[] = tabel.rijen.map((rij, i) => {
        const toets = toetsRij(rij);
        return {
          regel: i + 2, // kop = regel 1
          code: toets.code ?? '',
          eigenaarEmail: toets.eigenaarEmail,
          actie: toets.actie,
          waarschuwing: toets.waarschuwing,
          fout: toets.fout,
        };
      });
      const ongeldig = uitslagen.filter((u) => u.fout !== null).length;
      const rapport: ImportRapport = {
        formaat,
        kolommenOk,
        mistKolommen,
        totaalRijen: tabel.rijen.length,
        geldig: uitslagen.length - ongeldig,
        ongeldig,
        rijen: uitslagen,
        uitgevoerd: false,
        aangemaakteEenheden: 0,
        gekoppeldeEigenaren: 0,
        gestuurdeUitnodigingen: 0,
      };
      if (!bestand.uitvoeren || !kolommenOk || ongeldig > 0) {
        // Dry-run: validatie vooraf (AC2.7) — niets wordt geschreven.
        return rapport;
      }

      // Uitvoeren: per rij eenheid aanmaken/hergebruiken + eigenaar koppelen
      // of uitnodigen. Bestaande personen direct koppelen (§3.3); nieuwe
      // adressen via de uitnodigingstabel met opak token (V04-patroon).
      let aangemaakt = 0;
      let gekoppeld = 0;
      let uitnodigingen = 0;
      for (let i = 0; i < tabel.rijen.length; i += 1) {
        const rij = tabel.rijen[i];
        const uitslag = uitslagen[i];
        if (rij === undefined || uitslag === undefined || uitslag.fout !== null) continue;

        const eenheidId = await inTenantTransactie(db, vveId, async (tx) => {
          // Hergebruik bij code: de import is idempotent (AC2.7-geest).
          const [bestaand] = await tx
            .select({ id: wooneenheid.id })
            .from(wooneenheid)
            .where(and(eq(wooneenheid.vveId, vveId), eq(wooneenheid.code, uitslag.code)))
            .limit(1);
          if (bestaand !== undefined) return { id: bestaand.id, nieuw: false };
          const [insert] = await tx
            .insert(wooneenheid)
            .values({
              vveId,
              code: uitslag.code,
              type: eenheidType(cel(rij, 'type')),
              oppervlakteM2: oppervlakteGetal(cel(rij, 'oppervlakte_m2')),
              breukdeelTeller: geheel(cel(rij, 'breukdeel_teller'), 1),
              breukdeelNoemer: geheel(cel(rij, 'breukdeel_noemer'), 1000),
              stemmen: geheel(cel(rij, 'stemmen'), 1),
            })
            .returning({ id: wooneenheid.id });
          if (insert === undefined) throw new Error('wooneenheid-insert leverde geen id op');
          return { id: insert.id, nieuw: true };
        });
        if (eenheidId.nieuw) aangemaakt += 1;

        if (uitslag.eigenaarEmail === '') continue;
        const [bestaandPersoon] = await db
          .select({ id: persoon.id })
          .from(persoon)
          .where(eq(persoon.email, uitslag.eigenaarEmail))
          .limit(1);
        if (bestaandPersoon !== undefined) {
          const gekop = await koppelEigenaarIdempotent(
            vveId,
            eenheidId.id,
            bestaandPersoon.id,
            aandeelGetal(cel(rij, 'eigenaar_aandeel_promille')),
          );
          if (gekop) gekoppeld += 1;
        } else {
          const gestuurd = await nodigUit(
            vveId,
            eenheidId.id,
            uitslag.eigenaarEmail,
            doorPersoonId,
          );
          if (gestuurd) uitnodigingen += 1;
        }
      }

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'import.uitgevoerd',
        categorie: 'app',
        onderwerpTabel: 'wooneenheid',
        onderwerpId: null,
        details: {
          eenheden: aangemaakt,
          koppelingen: gekoppeld,
          uitnodigingen,
          rijen: tabel.rijen.length,
        },
      });

      return {
        ...rapport,
        uitgevoerd: true,
        aangemaakteEenheden: aangemaakt,
        gekoppeldeEigenaren: gekoppeld,
        gestuurdeUitnodigingen: uitnodigingen,
      };
    },
  };

  // -- helpers binnen de fabriek (hebben db/klok/registratieBasis nodig) ----

  /** Idempotente koppeling: geen dubbele lopende rij (V04-patroon). */
  async function koppelEigenaarIdempotent(
    vveId: bigint,
    eenheidId: bigint,
    persoonId: bigint,
    aandeel: number,
  ): Promise<boolean> {
    return inTenantTransactie(db, vveId, async (tx) => {
      const [lopend] = await tx
        .select({ id: eigenaarschap.id })
        .from(eigenaarschap)
        .where(
          and(
            eq(eigenaarschap.wooneenheidId, eenheidId),
            eq(eigenaarschap.persoonId, persoonId),
            sql`${eigenaarschap.periode} @> ${vandaag()}::date`,
          ),
        )
        .limit(1);
      if (lopend !== undefined) return false;
      await tx.insert(eigenaarschap).values({
        vveId,
        wooneenheidId: eenheidId,
        persoonId,
        aandeelPromille: aandeel,
        isPrimairContact: true,
        periode: `[${vandaag()},)`,
      });
      return true;
    });
  }

  /** Nieuw adres: uitnodiging met opak token + registratielink (V04-patroon). */
  async function nodigUit(
    vveId: bigint,
    eenheidId: bigint,
    email: string,
    doorPersoonId: bigint,
  ): Promise<boolean> {
    // Een lopende uitnodiging voor dit adres op deze eenheid? Dan niks doen
    // (idempotent; "opnieuw versturen" blijft V04's werk).
    const [lopende] = await db
      .select({ id: uitnodiging.id })
      .from(uitnodiging)
      .where(
        and(
          eq(uitnodiging.vveId, vveId),
          eq(uitnodiging.wooneenheidId, eenheidId),
          eq(uitnodiging.email, email),
        ),
      )
      .limit(1);
    if (lopende !== undefined) return false;

    const token = randomBytes(32).toString('hex');
    const nu = klok.nu();
    const verlooptOp = new Date(nu.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [rij] = await db
      .insert(uitnodiging)
      .values({
        vveId,
        wooneenheidId: eenheidId,
        email,
        rol: 'eigenaar',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        verlooptOp,
        verzondenOp: nu,
        aantalVerzonden: 1,
        aangemaaktDoor: doorPersoonId,
      })
      .returning({ id: uitnodiging.id });
    if (rij === undefined) throw new Error('uitnodiging-insert leverde geen id op');
    await verzendMail(
      email,
      'Uitnodiging VvE-portaal',
      `U bent als eigenaar toegevoegd. Registreer via ${registratieBasis}?token=${token}`,
    );
    return true;
  }
}

// -- zuivere veld-helpers (geen state) -------------------------------------

function eenheidType(waarde: string | undefined): (typeof EENHEID_TYPEN)[number] {
  if (waarde === undefined) return 'woning';
  const gevonden = EENHEID_TYPEN.find((t) => t === waarde);
  return gevewnType(gevonden);
}

function gevewnType(
  gevonden: (typeof EENHEID_TYPEN)[number] | undefined,
): (typeof EENHEID_TYPEN)[number] {
  return gevonden ?? 'woning';
}

function oppervlakteGetal(waarde: string | undefined): number | undefined {
  if (waarde === undefined) return undefined;
  return Number(waarde.replace(',', '.'));
}

function geheel(waarde: string | undefined, defaultWaarde: number): number {
  if (waarde === undefined) return defaultWaarde;
  const getal = Number(waarde);
  if (!Number.isInteger(getal) || getal < 0) {
    throw new InvoerFout('Kolomwaarde moet een geheel getal ≥ 0 zijn.');
  }
  return getal;
}

function aandeelGetal(waarde: string | undefined): number {
  if (waarde === undefined) return 1000;
  const getal = Number(waarde);
  if (!Number.isInteger(getal) || getal <= 0 || getal > 1000) {
    throw new InvoerFout('Het aandeel moet tussen 1 en 1000 promille liggen.');
  }
  return getal;
}
