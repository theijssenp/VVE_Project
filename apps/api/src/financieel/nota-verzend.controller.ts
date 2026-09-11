/**
 * Nota-verzend-endpoints — blok G07 (M13 · AC13.4/AC13.5).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `nota.lezen` (PDF ophalen) en
 * `nota.wijzigen` (bouw + serie-verzending).
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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import {
  maakMailService,
  type MailServiceInterface,
} from '../gemeenschappelijk/mail/mail-service.js';
import { LogVerzender } from './log-verzender.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { maakNotaVerzendService } from './nota-verzend-service.js';

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

function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

@Controller('notas')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class NotaVerzendController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    const verzender = new LogVerzender();
    const mail: MailServiceInterface = maakMailService({ db, verzender });
    this.#service = maakNotaVerzendService({ db, mail });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get(':id/pdf')
  @VereistRecht('nota.lezen')
  async pdf(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { bytes, bestandsnaam } = await this.#service.leverPdf(
        this.#eisTenant(verzoek),
        idUit(id, 'nota-id'),
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${bestandsnaam}"`);
      res.send(bytes);
    } catch (fout: unknown) {
      alsHttp(fout);
    }
  }

  @Post(':id/pdf')
  @VereistRecht('nota.wijzigen')
  async bouw(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      return await this.#service.bouwEnBewaar(
        this.#eisTenant(verzoek),
        idUit(id, 'nota-id'),
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('verzending')
  @VereistRecht('nota.wijzigen')
  async verzendSerie(
    @Req() verzoek: MetInlog,
    @Body() body: { periodeVan?: unknown },
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body.periodeVan !== 'string') {
      throw new BadRequestException('Veld "periodeVan" (string) is verplicht.');
    }
    try {
      return await this.#service.verzendSerie(this.#eisTenant(verzoek), body.periodeVan, persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
