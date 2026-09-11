/**
 * Grootboek-endpoints — blok G01 (AC9.1).
 *
 * Tenant-scoped op de §7.5-keten. Lezen mag voor elke rol met
 * `grootboek.lezen`; muteren eist `grootboek.wijzigen` (geen geldstroomrecht —
 * het schema zelf is geen geldbeweging; de boekingen eromheen komen in G02).
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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SystemKlok } from '../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import {
  InvoerFout,
  NietGevondenFout,
  maakGrootboekService,
  type GrootboekService,
} from './grootboek-service.js';

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

@Controller('grootboek')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class GrootboekController {
  readonly #service: GrootboekService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakGrootboekService({ db, klok: new SystemKlok() });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('grootboek.lezen')
  async lijst(@Req() verzoek: MetInlog, @Query('actief') actief?: string): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    return this.#service.lijst(vveId, actief === 'true' || actief === '1');
  }

  @Post()
  @VereistRecht('grootboek.wijzigen')
  async voegToe(
    @Req() verzoek: MetInlog,
    @Body()
    body: { nummer?: unknown; naam?: unknown; categorie?: unknown; isReservefonds?: unknown },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (
      typeof body.nummer !== 'string' ||
      typeof body.naam !== 'string' ||
      typeof body.categorie !== 'string'
    ) {
      throw new BadRequestException('Nummer, naam en categorie zijn verplicht.');
    }
    try {
      return await this.#service.voegToe(
        vveId,
        {
          nummer: body.nummer,
          naam: body.naam,
          categorie: body.categorie,
          isReservefonds: body.isReservefonds === true,
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Patch(':id')
  @VereistRecht('grootboek.wijzigen')
  async wijzig(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { naam?: unknown; actief?: unknown },
  ): Promise<{ ok: true }> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      await this.#service.wijzig(
        vveId,
        idUit(id, 'rekening-id'),
        {
          naam: typeof body.naam === 'string' ? body.naam : undefined,
          actief: typeof body.actief === 'boolean' ? body.actief : undefined,
        },
        persoonId,
      );
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
