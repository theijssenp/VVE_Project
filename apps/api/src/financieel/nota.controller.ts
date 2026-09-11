/**
 * Nota-endpoints — blok G06 (M6 · AC6.1–AC6.2).
 *
 * Tenant-scoped op de §7.5-keten (SessieGuard → TenantSessieGuard →
 * RolSessieGuard). Rechten: `nota.lezen` (lijst/detail) en `nota.wijzigen`
 * (generatie). Generatie eist een vastgesteld bijdrageschema en een open
 * boekjaar; de service bewaakt beide.
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

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { maakNotaService } from './nota-service.js';

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
export class NotaController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakNotaService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('nota.lezen')
  async lijst(@Req() verzoek: MetInlog, @Query('open') open: string | undefined): Promise<unknown> {
    const alleenOpen = open === '1' || open === 'true';
    const notas = await this.#service.lijst(this.#eisTenant(verzoek), alleenOpen);
    return { notas };
  }

  @Get(':id')
  @VereistRecht('nota.lezen')
  async detail(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    try {
      return await this.#service.detail(this.#eisTenant(verzoek), idUit(id, 'nota-id'));
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('generatie')
  @VereistRecht('nota.wijzigen')
  async genereer(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      boekjaarId?: unknown;
      periodeVan?: unknown;
      periodeTot?: unknown;
      factuurdatum?: unknown;
      vervaldatum?: unknown;
    },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    const paden = [
      'boekjaarId',
      'periodeVan',
      'periodeTot',
      'factuurdatum',
      'vervaldatum',
    ] as const;
    for (const veld of paden) {
      if (typeof body[veld] !== 'string') {
        throw new BadRequestException(`Veld "${veld}" (string) is verplicht.`);
      }
    }
    if (!/^\d+$/.test(body.boekjaarId as string)) {
      throw new BadRequestException('Veld "boekjaarId" (string-id) is verplicht.');
    }
    try {
      return await this.#service.genereerPeriode(
        vveId,
        {
          boekjaarId: BigInt(body.boekjaarId as string),
          periodeVan: body.periodeVan as string,
          periodeTot: body.periodeTot as string,
          factuurdatum: body.factuurdatum as string,
          vervaldatum: body.vervaldatum as string,
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
