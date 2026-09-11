/**
 * Debiteuren-endpoints — blok G09 (M6 · AC6.4/AC6.8).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `betaling.lezen` (overzicht) en
 * `debiteuren.dossier` (dossierinzage — apart recht, want §8.3 eist
 * toegangslogging op het dossier van een ander lid).
 */

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
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
import { SystemKlok } from '../gemeenschappelijk/system-klok.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { maakDebiteurenService } from './debiteuren-service.js';

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

@Controller('debiteuren')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class DebiteurenController {
  readonly #service;
  readonly #klok = new SystemKlok();

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakDebiteurenService({ db, klok: this.#klok });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get('ouderdomsanalyse')
  @VereistRecht('betaling.lezen')
  async ouderdomsanalyse(
    @Req() verzoek: MetInlog,
    @Query('peildatum') peildatum: string | undefined,
  ): Promise<unknown> {
    if (peildatum !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(peildatum)) {
      throw new BadRequestException('Query "peildatum" moet de vorm YYYY-MM-DD hebben.');
    }
    return await this.#service.ouderdomsanalyse(this.#eisTenant(verzoek), peildatum);
  }

  @Get('eenheden')
  @VereistRecht('betaling.lezen')
  async perEenheid(
    @Req() verzoek: MetInlog,
    @Query('peildatum') peildatum: string | undefined,
  ): Promise<unknown> {
    if (peildatum !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(peildatum)) {
      throw new BadRequestException('Query "peildatum" moet de vorm YYYY-MM-DD hebben.');
    }
    return { eenheden: await this.#service.perEenheid(this.#eisTenant(verzoek), peildatum) };
  }

  @Get('dossier/:eenheidId')
  @VereistRecht('debiteuren.dossier')
  async dossier(@Req() verzoek: MetInlog, @Param('eenheidId') eenheidId: string): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      const dossier = await this.#service.dossier(
        this.#eisTenant(verzoek),
        idUit(eenheidId, 'eenheid-id'),
        persoonId,
      );
      return dossier;
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
