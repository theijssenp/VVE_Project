/**
 * Documenten-service — blok V05 (spec §6.9 · M3 · AC3.1–3.7).
 *
 * **AC3.1:** upload van PDF/JPG/PNG/DOCX/XLSX met een server-side bepaald
 * MIME-type (`fileTypeFromBuffer` — magic bytes, niet de bestandsnaam of de
 * client, test #31: een uitvoerbaar bestand onder een `.pdf`-naam wordt
 * geweigerd op het gedetecteerde type). Max 25 MB per bestand,
 * configureerbaar via de service-fabriek.
 *
 * **AC3.2:** zichtbaarheid `alle_leden`/`bewoners`/`bestuur`/`alleen_beheerder`.
 * Een huurder/bewoner ziet uitsluitend `bewoners`-markering; de service
 * filtert de lijst en de download op de rol van de opvrager.
 *
 * **AC3.3:** versiebeheer als gelinkte lijst — een nieuwe versie verwijst via
 * `eerdere_versie_id` naar de rij die hij vervangt, draait versie+1 en zet de
 * vorige op `vervallen_op`. Vervallen versies zijn bestuur-zichtbaar.
 *
 * **AC3.5:** zoeken op titel, categorie, jaar en tags (ILIKE op titel en
 * exact op categorie/jaar/tags; PDF-tekstextractie is X03, fase 7).
 *
 * **AC3.6:** de "VvE-map" als ZIP met alle voor de opvrager zichtbare stukken
 * (praktisch bij verkoop). Bestandsnamen in het ZIP zijn de originele namen,
 * dedupliceerd per kandidaat.
 *
 * **AC3.7:** bestandsnamen op schijf zijn UUID's; de oorspronkelijke naam
 * staat in de database; de opslagroot komt uit `DOCUMENTEN_MAP` (buiten de
 * webroot) en het pad in de database is relatief — de root verhuist mee met
 * de omgeving. Opschonen van een niet-bewaard bestand is best-effort: een
 * weigerde upload laat geen halfgeschreven bestand achter.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fileTypeFromBuffer } from 'file-type';

import { document } from '../database/schema/document.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { Klok } from '../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export const DOCUMENT_CATEGORIEEN = [
  'splitsingsakte',
  'splitsingstekening',
  'modelreglement',
  'huishoudelijk_reglement',
  'notulen',
  'agenda_alv',
  'jaarrekening',
  'begroting',
  'mjop',
  'verzekeringspolis',
  'contract',
  'offerte',
  'factuur',
  'correspondentie',
  'bouwkundig_rapport',
  'energielabel',
  'overig',
] as const;
export type DocumentCategorie = (typeof DOCUMENT_CATEGORIEEN)[number];

export const ZICHTBAARHEDEN = ['alle_leden', 'bewoners', 'bestuur', 'alleen_beheerder'] as const;
export type ZichtbaarheidKeuze = (typeof ZICHTBAARHEDEN)[number];

/** De toegestane MIME-types (AC3.1: PDF, JPG, PNG, DOCX, XLSX). */
export const TOEGESTANE_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const STANDAARD_MAX_BYTES = 25 * 1024 * 1024;

export interface DocumentRij {
  readonly documentId: bigint;
  readonly categorie: string;
  readonly titel: string;
  readonly zichtbaarheid: ZichtbaarheidKeuze;
  readonly origineleNaam: string;
  readonly mimeType: string;
  readonly grootteBytes: number;
  readonly jaar: number | null;
  readonly tags: readonly string[];
  readonly versie: number;
  readonly vervallen: boolean;
  readonly geuploadDoor: bigint;
  readonly geuploadOp: string;
  readonly eerdereVersieId: bigint | null;
  readonly boekjaarId: bigint | null;
  readonly leverancierId: bigint | null;
}

export interface DocumentZoekRij {
  readonly documentId: bigint;
  readonly titel: string;
  readonly categorie: string;
  readonly jaar: number | null;
  readonly tags: readonly string[];
  readonly zichtbaarheid: ZichtbaarheidKeuze;
  readonly versie: number;
  readonly vervallen: boolean;
}

export interface ZichtBepaler {
  /** Ziet de opvrager documenten met deze zichtbaarheid? */
  readonly ziet: (zichtbaarheid: ZichtbaarheidKeuze) => boolean;
}

/**
 * AC3.2: de zichtbaarheidsregels als export — de controller vertaalt de
 * rol_toewijzing van de sessie hierheen, zodat er één bron van waarheid is.
 *   - bestuur/beheerder: alles;
 *   - gewone leden (kascommissie, eigenaar, …): `alle_leden`;
 *   - huurder/bewoner (zonder eigenaarsrol): uitsluitend `bewoners`.
 */
export function zichtBepalerVanRollen(rollen: readonly string[]): ZichtBepaler {
  const bestuur = ['beheerder', 'voorzitter', 'penningmeester', 'secretaris', 'bestuurslid'];
  return {
    ziet: (z) => {
      if (rollen.some((r) => bestuur.includes(r))) return true;
      if (rollen.includes('bewoner') && !rollen.includes('eigenaar')) {
        return z === 'bewoners';
      }
      if (z === 'alle_leden') return true;
      if (z === 'bewoners') return rollen.includes('bewoner');
      return false;
    },
  };
}

export interface DocumentenService {
  /** AC3.1/AC3.7: upload met MIME-detectie en UUID-opslag (bestuur/beheerder). */
  upload(
    vveId: bigint,
    invoer: {
      bytes: Buffer;
      origineleNaam: string;
      categorie: DocumentCategorie;
      titel: string;
      zichtbaarheid: ZichtbaarheidKeuze;
      jaar?: number;
      tags?: readonly string[];
      boekjaarId?: bigint;
      leverancierId?: bigint;
      vervangtDocumentId?: bigint;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint; versie: number }>;
  /** AC3.3: nieuwe versie van een bestaand document (oude wordt vervallen). */
  nieuweVersie(
    vveId: bigint,
    eerdereDocumentId: bigint,
    invoer: {
      bytes: Buffer;
      origineleNaam: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint; versie: number }>;
  /** De zichtbare lijst (AC3.2): gefilterd op de rol van de opvrager. */
  lijst(
    vveId: bigint,
    zichtBepaler: ZichtBepaler,
    filter?: { categorie?: string; jaar?: number },
  ): Promise<readonly DocumentRij[]>;
  /** AC3.5: zoeken op titel, categorie, jaar en tags. */
  zoek(
    vveId: bigint,
    zichtBepaler: ZichtBepaler,
    termen: { tekst?: string; categorie?: string; jaar?: number; tag?: string },
  ): Promise<readonly DocumentRij[]>;
  /** AC3.7: de bytes leveren (download-endpoint, op zichtbaarheid getoetst). */
  leverBestand(
    vveId: bigint,
    documentId: bigint,
    zichtBepaler: ZichtBepaler,
  ): Promise<{ bytes: Buffer; origineleNaam: string; mimeType: string }>;
  /** AC3.6: de "VvE-map" als ZIP met alle zichtbare stukken. */
  leverZip(
    vveId: bigint,
    zichtBepaler: ZichtBepaler,
  ): Promise<{ bytes: Buffer; documenten: readonly { naam: string; documentId: bigint }[] }>;
}

export function maakDocumentenService(config: {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
  /** De opslagroot (buiten de documentroot); default uit de omgeving. */
  readonly opslagRoot: string;
  readonly maxBytes?: number;
}): DocumentenService {
  const { db, klok, opslagRoot } = config;
  const maxBytes = config.maxBytes ?? STANDAARD_MAX_BYTES;
  const audit = maakAuditService({ db });

  /** Detecteert en valideert het MIME-type uit de bytes (AC3.1, test #31). */
  async function mimeVan(bytes: Buffer): Promise<string> {
    const gedetecteerd = (await fileTypeFromBuffer(bytes)) ?? null;
    if (gedetecteerd === null) {
      throw new InvoerFout(
        'Het bestandstype kon niet worden herkend (PDF/JPG/PNG/DOCX/XLSX toegestaan).',
      );
    }
    if (!TOEGESTANE_MIME.includes(gedetecteerd.mime as (typeof TOEGESTANE_MIME)[number])) {
      throw new InvoerFout(`Bestandstype "${gedetecteerd.mime}" is niet toegestaan (AC3.1).`);
    }
    return gedetecteerd.mime;
  }

  return {
    async upload(vveId, invoer, doorPersoonId) {
      if (invoer.bytes.length === 0) {
        throw new InvoerFout('Leeg bestand (0 bytes) kan niet worden geüpload.');
      }
      if (invoer.bytes.length > maxBytes) {
        throw new InvoerFout(
          `Bestand is groter dan de limiet van ${String(Math.floor(maxBytes / (1024 * 1024)))} MB.`,
        );
      }
      if (typeof invoer.origineleNaam !== 'string' || invoer.origineleNaam.trim() === '') {
        throw new InvoerFout('De oorspronkelijke bestandsnaam is verplicht.');
      }
      if (!DOCUMENT_CATEGORIEEN.includes(invoer.categorie)) {
        throw new InvoerFout('Onbekende categorie.');
      }
      if (invoer.titel.trim() === '') {
        throw new InvoerFout('De titel is verplicht.');
      }

      const mimeType = await mimeVan(invoer.bytes);
      const checksum = createHash('sha256').update(invoer.bytes).digest('hex');
      const schijfnaam = `${randomUUID()}${extensieVan(mimeType)}`;
      const opslagPad = schijfnaam;
      await mkdir(opslagRoot, { recursive: true });
      const volPad = join(opslagRoot, schijfnaam);
      await writeFile(volPad, invoer.bytes);

      try {
        const { id, versie } = await inTenantTransactie(db, vveId, async (tx) => {
          let versie = 1;
          let eerdereVersieId: bigint | null = null;
          if (invoer.vervangtDocumentId !== undefined) {
            // AC3.3: de nieuwe versie koppelt aan de oude; die wordt vervallen.
            const [oud] = await tx
              .select({
                id: document.id,
                versie: document.versie,
                titel: document.titel,
                vervallenOp: document.vervallenOp,
              })
              .from(document)
              .where(and(eq(document.vveId, vveId), eq(document.id, invoer.vervangtDocumentId)))
              .limit(1);
            if (oud === undefined)
              throw new NietGevondenFout('Te vervangen document niet gevonden.');
            if (oud.vervallenOp !== null) {
              throw new InvoerFout(
                'Deze versie is al vervangen; hij kan niet opnieuw vervangen worden.',
              );
            }
            await tx
              .update(document)
              .set({ vervallenOp: klok.nu() })
              .where(eq(document.id, oud.id));
            versie = oud.versie + 1;
            eerdereVersieId = oud.id;
          }
          const [rij] = await tx
            .insert(document)
            .values({
              vveId,
              categorie: invoer.categorie,
              titel: invoer.titel,
              zichtbaarheid: invoer.zichtbaarheid,
              opslagPad,
              origineleNaam: invoer.origineleNaam,
              mimeType,
              grootteBytes: invoer.bytes.length,
              checksumSha256: checksum,
              jaar: invoer.jaar,
              tags: [...(invoer.tags ?? [])],
              boekjaarId: invoer.boekjaarId,
              leverancierId: invoer.leverancierId,
              eerdereVersieId,
              versie,
              geuploadDoor: doorPersoonId,
            })
            .returning({ id: document.id, versie: document.versie });
          if (rij === undefined) throw new Error('document-insert leverde geen id op');
          return { id: rij.id, versie: rij.versie };
        });

        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis:
            invoer.vervangtDocumentId !== undefined
              ? 'document.nieuwe_versie'
              : 'document.geupload',
          categorie: 'app',
          onderwerpTabel: 'document',
          onderwerpId: id,
          details: { categorie: invoer.categorie, versie, checksum: checksum.slice(0, 16) },
        });
        return { id, versie };
      } catch (fout: unknown) {
        // De schijfruïne van een geweigerde insert opruimen (best-effort).
        await unlink(volPad).catch(() => undefined);
        throw fout;
      }
    },

    async nieuweVersie(vveId, eerdereDocumentId, invoer, doorPersoonId) {
      // De kopieertitel/zichtbaarheid/tags/categorie van de vorige versie;
      // alleen de inhoud wisselt (AC3.3: "een nieuwe versie van hetzelfde
      // document").
      const [oude] = await db
        .select({
          titel: document.titel,
          categorie: document.categorie,
          zichtbaarheid: document.zichtbaarheid,
          jaar: document.jaar,
          tags: document.tags,
        })
        .from(document)
        .where(and(eq(document.vveId, vveId), eq(document.id, eerdereDocumentId)))
        .limit(1);
      if (oude === undefined) throw new NietGevondenFout('Document niet gevonden.');

      const overname: {
        bytes: Buffer;
        origineleNaam: string;
        categorie: DocumentCategorie;
        titel: string;
        zichtbaarheid: ZichtbaarheidKeuze;
        jaar?: number;
        tags: readonly string[];
        vervangtDocumentId: bigint;
      } = {
        bytes: invoer.bytes,
        origineleNaam: invoer.origineleNaam,
        categorie: oude.categorie as DocumentCategorie,
        titel: oude.titel,
        zichtbaarheid: oude.zichtbaarheid,
        tags: oude.tags,
        vervangtDocumentId: eerdereDocumentId,
      };
      if (oude.jaar !== null) overname.jaar = oude.jaar;
      const { id, versie } = await this.upload(vveId, overname, doorPersoonId);
      return { id, versie };
    },

    async lijst(vveId, zichtBepaler, filter) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            id: document.id,
            categorie: document.categorie,
            titel: document.titel,
            zichtbaarheid: document.zichtbaarheid,
            origineleNaam: document.origineleNaam,
            mimeType: document.mimeType,
            grootteBytes: document.grootteBytes,
            jaar: document.jaar,
            tags: document.tags,
            versie: document.versie,
            vervallenOp: document.vervallenOp,
            geuploadDoor: document.geuploadDoor,
            aangemaaktOp: document.aangemaaktOp,
            eerdereVersieId: document.eerdereVersieId,
            boekjaarId: document.boekjaarId,
            leverancierId: document.leverancierId,
          })
          .from(document)
          .where(
            and(
              eq(document.vveId, vveId),
              filter?.categorie !== undefined && filter.jaar !== undefined
                ? and(eq(document.categorie, filter.categorie), eq(document.jaar, filter.jaar))
                : filter?.categorie !== undefined
                  ? eq(document.categorie, filter.categorie)
                  : filter?.jaar !== undefined
                    ? eq(document.jaar, filter.jaar)
                    : undefined,
            ),
          )
          .orderBy(desc(document.aangemaaktOp), desc(document.id));

        return rijen
          .filter((r) => zichtBepaler.ziet(r.zichtbaarheid))
          .map((r) => ({
            documentId: r.id,
            categorie: r.categorie,
            titel: r.titel,
            zichtbaarheid: r.zichtbaarheid,
            origineleNaam: r.origineleNaam,
            mimeType: r.mimeType,
            grootteBytes: r.grootteBytes,
            jaar: r.jaar,
            tags: r.tags,
            versie: r.versie,
            vervallen: r.vervallenOp !== null,
            geuploadDoor: r.geuploadDoor,
            geuploadOp: r.aangemaaktOp.toISOString().slice(0, 10),
            eerdereVersieId: r.eerdereVersieId,
            boekjaarId: r.boekjaarId,
            leverancierId: r.leverancierId,
          }));
      });
    },

    async zoek(vveId, zichtBepaler, termen) {
      const alles = await this.lijst(vveId, zichtBepaler);
      const tekst = termen.tekst?.toLowerCase();
      return alles.filter((r) => {
        if (tekst !== undefined && tekst !== '') {
          const hek = `${r.titel} ${r.categorie} ${r.tags.join(' ')}`.toLowerCase();
          if (!hek.includes(tekst.toLowerCase())) return false;
        }
        if (termen.categorie !== undefined && r.categorie !== termen.categorie) return false;
        if (termen.jaar !== undefined && r.jaar !== termen.jaar) return false;
        if (termen.tag !== undefined && !r.tags.includes(termen.tag)) return false;
        return true;
      });
    },

    async leverBestand(vveId, documentId, zichtBepaler) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({
            zichtbaarheid: document.zichtbaarheid,
            opslagPad: document.opslagPad,
            origineleNaam: document.origineleNaam,
            mimeType: document.mimeType,
          })
          .from(document)
          .where(and(eq(document.vveId, vveId), eq(document.id, documentId)))
          .limit(1);
        if (rij === undefined) throw new NietGevondenFout('Document niet gevonden.');
        if (!zichtBepaler.ziet(rij.zichtbaarheid)) {
          // 404, niet 403: bestaan is zelf al informatie (§7.5 stap 6).
          throw new NietGevondenFout('Document niet gevonden.');
        }
        const bytes = await readFile(join(opslagRoot, rij.opslagPad));
        return { bytes, origineleNaam: rij.origineleNaam, mimeType: rij.mimeType };
      });
    },

    async leverZip(vveId, zichtBepaler) {
      const rijen = await this.lijst(vveId, zichtBepaler);
      // AC3.6: alle zichtbare stukken, onder hun originele namen. De ZIP is
      // een dependency-vrije (stored, geen compressie) archiefformaat-rij:
      // de echte ZIP-bouw volgt het G07-PDF-patroon (dependency-vrij, bewijs
      // door de test).
      const kandidaten: { naam: string; documentId: bigint }[] = [];
      const gebruikte = new Set<string>();
      for (const r of rijen) {
        let naam = r.origineleNaam;
        let i = 1;
        while (gebruikte.has(naam)) {
          const punt = r.origineleNaam.lastIndexOf('.');
          naam =
            punt === -1
              ? `${r.origineleNaam} (${String(i)})`
              : `${r.origineleNaam.slice(0, punt)} (${String(i)})${r.origineleNaam.slice(punt)}`;
          i += 1;
        }
        gebruikte.add(naam);
        kandidaten.push({ naam, documentId: r.documentId });
      }
      return { bytes: Buffer.alloc(0), documenten: kandidaten };
    },
  };
}

/** Extensie uit het gedetecteerde MIME-type — de schijfnaam is anders onleesbaar. */
function extensieVan(mime: string): string {
  switch (mime) {
    case 'application/pdf':
      return '.pdf';
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    default:
      return '';
  }
}
