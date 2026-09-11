/**
 * Mededeling-endpoints — blok A06 (M13 · AC13.1/AC13.3).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `mededeling.lezen` (de laatste
 * mededelingen, ook voor eigenaren) en `mededeling.wijzigen` (publiceren,
 * sjabloon).
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import {
  maakMailService,
  type MailServiceInterface,
} from '../gemeenschappelijk/mail/mail-service.js';
import { LogVerzender } from './log-verzender.js';
import { maakMededelingService } from './mededeling-service.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null; mfaGeauthenticeerd: boolean };
}

function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

@Controller('mededelingen')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class MededelingController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    const verzender = new LogVerzender();
    const mail: MailServiceInterface = maakMailService({ db, verzender });
    this.#service = maakMededelingService({ db, mail });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('mededeling.lezen')
  async laatste(
    @Req() verzoek: MetInlog,
    @Query('aantal') aantal: string | undefined,
  ): Promise<unknown> {
    const limiet = aantal !== undefined && /^\d+$/.test(aantal) ? Number(aantal) : 10;
    return { mededelingen: await this.#service.laatste(this.#eisTenant(verzoek), limiet) };
  }

  @Post()
  @VereistRecht('mededeling.wijzigen')
  async publiceer(
    @Req() verzoek: MetInlog,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    const doelgroep = body['doelgroep'];
    if (doelgroep !== 'alle_leden' && doelgroep !== 'eigenaren' && doelgroep !== 'bewoners') {
      throw new BadRequestException('doelgroep moet "alle_leden", "eigenaren" of "bewoners" zijn.');
    }
    if (typeof body['titel'] !== 'string' || typeof body['inhoud'] !== 'string') {
      throw new BadRequestException('Velden titel en inhoud (strings) zijn verplicht.');
    }
    try {
      return await this.#service.publiceer(
        this.#eisTenant(verzoek),
        {
          titel: body['titel'],
          inhoud: body['inhoud'],
          doelgroep,
          verzendMail: body['verzendMail'] === true,
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Get('sjabloon')
  @VereistRecht('mededeling.wijzigen')
  async sjabloon(@Req() verzoek: MetInlog): Promise<unknown> {
    return await this.#service.sjabloon(this.#eisTenant(verzoek));
  }

  @Post('sjabloon')
  @VereistRecht('mededeling.wijzigen')
  async zetSjabloon(
    @Req() verzoek: MetInlog,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body['afzendernaam'] !== 'string') {
      throw new BadRequestException('Veld "afzendernaam" (string) is verplicht.');
    }
    try {
      await this.#service.zetSjabloon(
        this.#eisTenant(verzoek),
        {
          afzendernaam: body['afzendernaam'],
          ...(typeof body['ondertekening'] === 'string'
            ? { ondertekening: body['ondertekening'] }
            : {}),
          ...(typeof body['logoUrl'] === 'string' ? { logoUrl: body['logoUrl'] } : {}),
        },
        persoonId,
      );
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
