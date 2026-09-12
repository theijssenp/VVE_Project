/**
 * Eigenaarschap-endpoints — blok V03 (spec M2 · AC2.4/AC2.5).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `eigenaarschap.lezen` (de
 * eigenaren-lijst en het verrekenoverzicht) en `eigenaarschap.wijzigen`
 * (toevoegen, primair contact, de wissel). Geen geldstroomrechten (§8.5):
 * facturatie en incasso volgen het primaire contact, maar het muteren van
 * eigenaarschap zelf raakt geen geldbeweging — MFA-herauthenticatie is hier
 * dus niet aan de orde.
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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SystemKlok } from '../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { maakEigenaarschapService } from './eigenaarschap-service.js';

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

function bigintUit(waarde: unknown, veld: string): bigint {
  if (typeof waarde === 'bigint') return waarde;
  if (typeof waarde === 'string' && /^\d+$/.test(waarde)) return BigInt(waarde);
  throw new BadRequestException(`Veld "${veld}" is verplicht (persoon-id).`);
}

/** Vertaalt de servicefouten naar HTTP; de service kent geen HTTP. */
function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

@Controller('eigenaarschap')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class EigenaarschapController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakEigenaarschapService({ db, klok: new SystemKlok() });
  }

  /** De tenant uit het token; een afwijkende id in de request is een fout (§7.5). */
  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  /** De eigenaren van een eenheid (huidig en historie, AC2.4). */
  @Get('eenheid/:eenheidId')
  @VereistRecht('eigenaarschap.lezen')
  async eigenaren(
    @Req() verzoek: MetInlog,
    @Param('eenheidId') eenheidId: string,
  ): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return { eigenaren: await this.#service.eigenaren(vveId, idUit(eenheidId, 'eenheid-id')) };
  }

  /** AC2.5: het verrekenoverzicht voor de notaris. */
  @Get('eenheid/:eenheidId/verrekenoverzicht/:leveringsdatum')
  @VereistRecht('eigenaarschap.lezen')
  async verrekenOverzicht(
    @Req() verzoek: MetInlog,
    @Param('eenheidId') eenheidId: string,
    @Param('leveringsdatum') leveringsdatum: string,
  ): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    try {
      return await this.#service.verrekenOverzicht(
        vveId,
        idUit(eenheidId, 'eenheid-id'),
        leveringsdatum,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC2.4: voeg een (tweede) eigenaar toe met aandeel en primair-contact-vlag. */
  @Post('eenheid/:eenheidId')
  @VereistRecht('eigenaarschap.wijzigen')
  async voegEigenaarToe(
    @Req() verzoek: MetInlog,
    @Param('eenheidId') eenheidId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const nieuwePersoonId = bigintUit(body['persoonId'], 'persoonId');
    const aandeelOnbewerkt = body['aandeelPromille'];
    if (
      aandeelOnbewerkt !== undefined &&
      (typeof aandeelOnbewerkt !== 'number' || !Number.isInteger(aandeelOnbewerkt))
    ) {
      throw new BadRequestException('aandeelPromille moet een geheel getal (promille) zijn.');
    }
    const vanafOnbewerkt = body['vanaf'];
    if (vanafOnbewerkt !== undefined && typeof vanafOnbewerkt !== 'string') {
      throw new BadRequestException('vanaf moet een datum (YYYY-MM-DD) zijn.');
    }
    const invoer: {
      persoonId: bigint;
      aandeelPromille?: number;
      isPrimairContact: boolean;
      vanaf?: string;
    } = { persoonId: nieuwePersoonId, isPrimairContact: body['isPrimairContact'] === true };
    if (aandeelOnbewerkt !== undefined) invoer.aandeelPromille = aandeelOnbewerkt;
    if (vanafOnbewerkt !== undefined) invoer.vanaf = vanafOnbewerkt;
    try {
      return await this.#service.voegEigenaarToe(
        vveId,
        idUit(eenheidId, 'eenheid-id'),
        invoer,
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC2.4: zet het primaire contact over naar een andere eigenaar. */
  @Post('eenheid/:eenheidId/primair/:eigenaarschapId')
  @VereistRecht('eigenaarschap.wijzigen')
  async zetPrimairContact(
    @Req() verzoek: MetInlog,
    @Param('eenheidId') eenheidId: string,
    @Param('eigenaarschapId') eigenaarschapId: string,
  ): Promise<{ ok: true }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      await this.#service.zetPrimairContact(
        vveId,
        idUit(eenheidId, 'eenheid-id'),
        idUit(eigenaarschapId, 'eigenaarschap-id'),
        persoonId,
      );
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC2.5: de eigenaarswissel op de leveringsdatum. */
  @Post('eenheid/:eenheidId/wissel')
  @VereistRecht('eigenaarschap.wijzigen')
  async wisselEigenaar(
    @Req() verzoek: MetInlog,
    @Param('eenheidId') eenheidId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    const nieuwePersoonId = bigintUit(body['nieuwePersoonId'], 'nieuwePersoonId');
    if (typeof body['leveringsdatum'] !== 'string') {
      throw new BadRequestException('Veld "leveringsdatum" (YYYY-MM-DD) is verplicht.');
    }
    const aandeelOnbewerkt = body['aandeelPromille'];
    if (
      aandeelOnbewerkt !== undefined &&
      (typeof aandeelOnbewerkt !== 'number' || !Number.isInteger(aandeelOnbewerkt))
    ) {
      throw new BadRequestException('aandeelPromille moet een geheel getal (promille) zijn.');
    }
    const invoer: {
      nieuwePersoonId: bigint;
      leveringsdatum: string;
      aandeelPromille?: number;
    } = { nieuwePersoonId, leveringsdatum: body['leveringsdatum'] };
    if (aandeelOnbewerkt !== undefined) invoer.aandeelPromille = aandeelOnbewerkt;
    try {
      return await this.#service.wisselEigenaar(
        vveId,
        idUit(eenheidId, 'eenheid-id'),
        invoer,
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
