/**
 * Eenheden-endpoints — blok V02 (spec M2 · AC2.1, AC2.3).
 *
 * De eerste tenant-scoped routes van de applicatie: de volledige §7.5-keten
 * (AuthGuard → TenantGuard → RolGuard) op elke route. De tenant komt uit de
 * `vve_id`-claim van het access-token — de client kiest niets; een VvE-id in
 * body, query of pad wordt alleen geaccepteerd als hij gelijk is aan de
 * context (spec §7.5 stap 2).
 *
 * Rechtennamen volgen het §7.5-patroon `<domein>.<handeling>`; geen van deze
 * rechten staat op de geldstroomlijst (§8.5), dus de RolGuard eist hier geen
 * MFA-herauthenticatie.
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
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { DATABASE } from '../../database/database.module.js';
import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../../gemeenschappelijk/auth/tenant-guards.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../auth/sessie.guard.js';
import { ZodValidationPipe } from '../../gemeenschappelijk/validatie/zod-pipe.js';
import {
  InvoerFout,
  NietGevondenFout,
  maakEenhedenService,
  type EenheidInvoer,
  type EenhedenService,
} from './eenheden.service.js';
import { maakImportService, type ImportService } from './import-service.js';
import { LogVerzender } from '../../financieel/log-verzender.js';
import {
  maakMailService,
  type MailServiceInterface,
} from '../../gemeenschappelijk/mail/mail-service.js';

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

@Controller('vve-mij')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class EenhedenController {
  readonly #service: EenhedenService;
  readonly #import: ImportService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakEenhedenService({ db, klok: new SystemKlok() });
    const verzender = new LogVerzender();
    const mail: MailServiceInterface = maakMailService({ db, verzender });
    this.#import = maakImportService({
      db,
      klok: new SystemKlok(),
      registratieBasis: process.env['REGISTRATIE_BASIS'] ?? 'https://vve.example.nl/registratie',
      verzendMail: async (aan, onderwerp, tekst) => {
        await mail.zetInWachtrij({ vveId: null, ontvangerEmail: aan, onderwerp, tekst });
      },
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

  /** Overzicht met eenheden, gebouwen en de AC2.3-somcontrole. */
  @Get()
  @VereistRecht('eenheid.lezen')
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return this.#service.lijst(vveId);
  }

  @Post()
  @VereistRecht('eenheid.aanmaken')
  async maak(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      eenheid?: EenheidInvoer;
      eigenaar?: { persoonId?: unknown; aandeelPromille?: unknown } | null;
    },
  ): Promise<{ eenheidId: bigint }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    if (body.eenheid === undefined) {
      throw new BadRequestException('Veld "eenheid" is verplicht.');
    }

    // AC2.1: zonder expliciete eigenaar wordt de ingelogde beheerder gekoppeld.
    // Een andere persoon mag hier alleen met een expliciet opgegeven persoon-id
    // (buren pas volledig in V04; de koppeling zelf bestaat al).
    let eigenaar: { persoonId: bigint; aandeelPromille: number } | null = {
      persoonId,
      aandeelPromille: 1000,
    };
    if (body.eigenaar !== undefined && body.eigenaar !== null) {
      const opgegeven = body.eigenaar.persoonId;
      const aandeel = body.eigenaar.aandeelPromille;
      if (typeof opgegeven === 'string' && /^\d+$/.test(opgegeven)) {
        eigenaar = {
          persoonId: BigInt(opgegeven),
          aandeelPromille: typeof aandeel === 'number' ? aandeel : 1000,
        };
      }
    }

    try {
      return await this.#service.maakEenheid(vveId, body.eenheid, eigenaar);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Patch(':id')
  @VereistRecht('eenheid.wijzigen')
  async wijzig(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: Partial<EenheidInvoer>,
  ): Promise<{ ok: true }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      await this.#service.wijzigEenheid(vveId, idUit(id, 'eenheid-id'), body, persoonId);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  // -- V06: bulk-import (AC2.7) --------------------------------------------

  /** Het voorbeeldbestand (AC2.7) als tekst — hetzelfde model de parser leest. */
  @Get('import/voorbeeld')
  @VereistRecht('eenheid.lezen')
  importVoorbeeld(): unknown {
    return { csv: this.#import.voorbeeldCsv() };
  }

  private static readonly IMPORT_SCHEMA = z
    .object({
      bestand: z.object({
        /** De CSV- of XLSX-inhoud als base64 (strak Zod: test #30). */
        inhoud: z.string().min(1),
      }),
      /** false (default) = dry-run-rapport; true = daadwerkelijk uitvoeren. */
      uitvoeren: z.boolean().optional(),
    })
    .strict();

  /** AC2.7: valideer (dry-run) of uitvoeren, met per-rij-rapport. */
  @Post('import')
  @VereistRecht('eenheid.wijzigen')
  async importeren(
    @Req() verzoek: MetInlog,
    @Body(new ZodValidationPipe(EenhedenController.IMPORT_SCHEMA))
    body: { bestand: { inhoud: string }; uitvoeren?: boolean },
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.bestand.inhoud, 'base64');
    } catch {
      throw new BadRequestException('De bestandsinhoud is geen geldige base64.');
    }
    if (bytes.length === 0) {
      throw new BadRequestException('Leeg bestand (0 bytes) kan niet worden geïmporteerd.');
    }
    try {
      return await this.#import.verwerk(
        vveId,
        { bytes, uitvoeren: body.uitvoeren === true },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
