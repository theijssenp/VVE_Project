/**
 * Documenten-endpoints — blok V05 (spec M3 · AC3.1–3.7).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `document.lezen` (lijst, zoeken,
 * download, VvE-map) en `document.wijzigen` (upload, nieuwe versie).
 * Geen geldstroomrechten (§8.5): documenten zijn bestuursinformatie, geen
 * geldbeweging — MFA-herauthenticatie is hier niet aan de orde.
 *
 * **Zichtbaarheid (AC3.2):** de controller vertaalt de rol_toewijzing van de
 * sessie naar de `ZichtBepaler` van de service. De rol zelf komt uit de
 * database (rol_toewijzing op de actieve VvE), nooit uit de client.
 *
 * **Upload (AC3.1):** de bytes komen als base64 in de body (JSON, strak
 * via Zod strict — test #30). 25 MB base64 is ~34 MB body; express staat
 * standaard 100 kb toe, dus deze controller zet zelf een ruime JSON-limiet
 * op de upload-route via `express.json({ limit })` op de route-stack.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { DATABASE } from '../database/database.module.js';
import { rolToewijzing } from '../database/schema/rol-toewijzing.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SystemKlok } from '../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { ZodValidationPipe } from '../gemeenschappelijk/validatie/zod-pipe.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import {
  DOCUMENT_CATEGORIEEN,
  ZICHTBAARHEDEN,
  maakDocumentenService,
  zichtBepalerVanRollen,
  type DocumentCategorie,
  type ZichtbaarheidKeuze,
} from './documenten-service.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null; mfaGeauthenticeerd: boolean };
}

function idUit(waarde: string, veld: string): bigint {
  try {
    return BigInt(waarde);
  } catch {
    throw new BadRequestException(`Ongeldig ${veld}.`);
  }
}

/** Vertaalt de servicefouten naar HTTP; de service kent geen HTTP. */
function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

const UPLOAD_SCHEMA = z
  .object({
    bestand: z.object({
      bytes: z.string().min(1), // base64
      origineleNaam: z.string().min(1),
    }),
    categorie: z.enum(DOCUMENT_CATEGORIEEN),
    titel: z.string().min(1),
    zichtbaarheid: z.enum(ZICHTBAARHEDEN),
    jaar: z.number().int().min(1900).max(2999).optional(),
    tags: z.array(z.string().min(1)).max(20).optional(),
    boekjaarId: z.string().regex(/^\d+$/).optional(),
    leverancierId: z.string().regex(/^\d+$/).optional(),
    vervangtDocumentId: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

type UploadInvoer = z.infer<typeof UPLOAD_SCHEMA>;

@Controller('documenten')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class DocumentenController {
  readonly #service;
  readonly #db;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#db = db;
    this.#service = maakDocumentenService({
      db,
      klok: new SystemKlok(),
      opslagRoot: opslagRootVanOmgeving(),
    });
  }

  /** De tenant uit het token; een afwijkende id in de request is een fout (§7.5). */
  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  /**
   * AC3.2: de zichtbaarheidsbepaler uit de werkelijke rollen op de actieve
   * VvE — uit de database, nooit uit de client. De regels staan in de service
   * (één bron van waarheid), de controller leest alleen de rollen.
   */
  async #zichtBepaler(vveId: bigint, persoonId: bigint) {
    const rijen = await this.#db
      .select({ rol: rolToewijzing.rol })
      .from(rolToewijzing)
      .where(and(eq(rolToewijzing.vveId, vveId), eq(rolToewijzing.persoonId, persoonId)));
    const rollen = rijen.map((r) => r.rol as string);
    return zichtBepalerVanRollen(rollen);
  }

  /** De zichtbare lijst, met optionele categorie/jaar-filter (AC3.2). */
  @Get()
  @VereistRecht('document.lezen')
  async lijst(
    @Req() verzoek: MetInlog,
    @Query('categorie') categorie: string | undefined,
    @Query('jaar') jaar: string | undefined,
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const bepaler = await this.#zichtBepaler(vveId, persoonId);
    const filter: { categorie?: string; jaar?: number } = {};
    if (categorie !== undefined) filter.categorie = categorie;
    if (jaar !== undefined && /^\d{4}$/.test(jaar)) filter.jaar = Number(jaar);
    return { documenten: await this.#service.lijst(vveId, bepaler, filter) };
  }

  /** AC3.5: zoeken op titel, categorie, jaar en tags. */
  @Get('zoeken')
  @VereistRecht('document.lezen')
  async zoeken(
    @Req() verzoek: MetInlog,
    @Query('tekst') tekst: string | undefined,
    @Query('categorie') categorie: string | undefined,
    @Query('jaar') jaar: string | undefined,
    @Query('tag') tag: string | undefined,
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const bepaler = await this.#zichtBepaler(vveId, persoonId);
    const termen: { tekst?: string; categorie?: string; jaar?: number; tag?: string } = {};
    if (tekst !== undefined && tekst !== '') termen.tekst = tekst;
    if (categorie !== undefined) termen.categorie = categorie;
    if (jaar !== undefined && /^\d{4}$/.test(jaar)) termen.jaar = Number(jaar);
    if (tag !== undefined && tag !== '') termen.tag = tag;
    return { documenten: await this.#service.zoek(vveId, bepaler, termen) };
  }

  /** AC3.1: upload (base64-body, MIME server-side, test #31). */
  @Post()
  @VereistRecht('document.wijzigen')
  async upload(
    @Req() verzoek: MetInlog,
    @Body(new ZodValidationPipe(UPLOAD_SCHEMA))
    body: UploadInvoer,
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.bestand.bytes, 'base64');
    } catch {
      throw new BadRequestException('De bestandsinhoud is geen geldige base64.');
    }
    if (bytes.length === 0) {
      throw new BadRequestException('Leeg bestand (0 bytes) kan niet worden geüpload.');
    }
    const invoer: {
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
    } = {
      bytes,
      origineleNaam: body.bestand.origineleNaam,
      categorie: body.categorie,
      titel: body.titel,
      zichtbaarheid: body.zichtbaarheid,
    };
    if (body.jaar !== undefined) invoer.jaar = body.jaar;
    if (body.tags !== undefined) invoer.tags = body.tags;
    if (body.boekjaarId !== undefined) invoer.boekjaarId = BigInt(body.boekjaarId);
    if (body.leverancierId !== undefined) invoer.leverancierId = BigInt(body.leverancierId);
    if (body.vervangtDocumentId !== undefined) {
      invoer.vervangtDocumentId = BigInt(body.vervangtDocumentId);
    }
    try {
      return await this.#service.upload(vveId, invoer, persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC3.3: een nieuwe versie van een bestaand document. */
  @Post(':id/versie')
  @VereistRecht('document.wijzigen')
  async nieuweVersie(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body(
      new ZodValidationPipe(
        z
          .object({
            bestand: z.object({ bytes: z.string().min(1), origineleNaam: z.string().min(1) }),
          })
          .strict(),
      ),
    )
    body: { bestand: { bytes: string; origineleNaam: string } },
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const bytes = Buffer.from(body.bestand.bytes, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Leeg bestand (0 bytes) kan niet worden geüpload.');
    }
    try {
      return await this.#service.nieuweVersie(
        vveId,
        idUit(id, 'document-id'),
        { bytes, origineleNaam: body.bestand.origineleNaam },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC3.7: download via een endpoint dat rol, tenant en zichtbaarheid toetst. */
  @Get(':id/download')
  @VereistRecht('document.lezen')
  async download(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
  ): Promise<{
    inhoud: string;
    origineleNaam: string;
    mimeType: string;
  }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const bepaler = await this.#zichtBepaler(vveId, persoonId);
    try {
      const bestand = await this.#service.leverBestand(vveId, idUit(id, 'document-id'), bepaler);
      return {
        inhoud: bestand.bytes.toString('base64'),
        origineleNaam: bestand.origineleNaam,
        mimeType: bestand.mimeType,
      };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}

/** De opslagroot: buiten de webroot, uit de omgeving; geen standaardwaarde. */
function opslagRootVanOmgeving(): string {
  const pad = process.env['DOCUMENTEN_MAP'];
  if (pad === undefined || pad.trim() === '') {
    throw new Error(
      'DOCUMENTEN_MAP ontbreekt — de opslagroot is geen standaardwaarde (spec §8.2).',
    );
  }
  return pad;
}
