/**
 * Begroting-endpoints — blok G04 (M5 · AC5.1, AC5.7).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `begroting.lezen` (detail,
 * vergelijking — ook kascommissie-waardig) en `begroting.wijzigen`
 * (aanmaken, regels, statusschuif). PDF-export is nog niet gebouwd; het
 * detail-endpoint levert de volledige ALV-tabel als data (AC5.7-basis).
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
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { maakBegrotingService, type RegelInvoer } from './begroting-service.js';

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

/** Regels uit JSON; weigert slechte invoer vroeg (§7.5-stap 4-geest). */
function regelsUit(invoer: unknown): RegelInvoer[] {
  if (!Array.isArray(invoer) || invoer.length === 0) {
    throw new BadRequestException('Veld "regels" is een niet-lege lijst verplicht.');
  }
  return invoer.map((r) => {
    if (
      typeof r !== 'object' ||
      r === null ||
      typeof (r as { rekeningNummer?: unknown }).rekeningNummer !== 'string' ||
      typeof (r as { omschrijving?: unknown }).omschrijving !== 'string' ||
      typeof (r as { bedragCent?: unknown }).bedragCent !== 'number' ||
      typeof (r as { verdeelsleutelId?: unknown }).verdeelsleutelId !== 'string' ||
      !/^\d+$/.test((r as { verdeelsleutelId?: unknown }).verdeelsleutelId as string)
    ) {
      throw new BadRequestException(
        'Elke regel heeft rekeningNummer (string), omschrijving (string), bedragCent (number) en verdeelsleutelId (string-id) nodig.',
      );
    }
    const rij = r as {
      rekeningNummer: string;
      omschrijving: string;
      bedragCent: number;
      verdeelsleutelId: string;
      isReservefonds?: unknown;
      volgorde?: unknown;
    };
    return {
      grootboekrekeningNummer: rij.rekeningNummer,
      omschrijving: rij.omschrijving,
      bedragCent: rij.bedragCent,
      verdeelsleutelId: BigInt(rij.verdeelsleutelId),
      isReservefonds: rij.isReservefonds === true,
      volgorde: typeof rij.volgorde === 'number' ? rij.volgorde : undefined,
    };
  });
}

@Controller('begrotingen')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class BegrotingController {
  readonly #service = undefined as never as {
    maak(
      vveId: bigint,
      boekjaarId: bigint,
      regels: readonly RegelInvoer[],
      doorPersoonId: bigint,
    ): Promise<{ id: bigint }>;
    vervangRegels(
      vveId: bigint,
      begrotingId: bigint,
      regels: readonly RegelInvoer[],
      doorPersoonId: bigint,
    ): Promise<void>;
    zetStatus(
      vveId: bigint,
      begrotingId: bigint,
      status: 'voorgesteld_alv' | 'vastgesteld' | 'gesloten',
      doorPersoonId: bigint,
    ): Promise<void>;
    detail(vveId: bigint, boekjaarId: bigint): Promise<unknown>;
  };

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakBegrotingService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get(':boekjaarId')
  @VereistRecht('begroting.lezen')
  async detail(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
  ): Promise<unknown> {
    try {
      return await this.#service.detail(this.#eisTenant(verzoek), idUit(boekjaarId, 'boekjaar-id'));
    } catch (fout: unknown) {
      if (fout instanceof InvoerFout || fout instanceof NietGevondenFout) return alsHttp(fout);
      throw fout;
    }
  }

  @Post()
  @VereistRecht('begroting.wijzigen')
  async maak(
    @Req() verzoek: MetInlog,
    @Body() body: { boekjaarId?: unknown; regels?: unknown },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body.boekjaarId !== 'string' || !/^\d+$/.test(body.boekjaarId)) {
      throw new BadRequestException('Veld "boekjaarId" (string-id) is verplicht.');
    }
    try {
      return await this.#service.maak(
        vveId,
        BigInt(body.boekjaarId),
        regelsUit(body.regels),
        persoonId,
      );
    } catch (fout: unknown) {
      if (fout instanceof InvoerFout || fout instanceof NietGevondenFout) return alsHttp(fout);
      throw fout;
    }
  }

  @Post(':id/regels')
  @VereistRecht('begroting.wijzigen')
  async vervangRegels(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { regels?: unknown },
  ): Promise<{ ok: true }> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      await this.#service.vervangRegels(
        vveId,
        idUit(id, 'begroting-id'),
        regelsUit(body.regels),
        persoonId,
      );
      return { ok: true };
    } catch (fout: unknown) {
      if (fout instanceof InvoerFout || fout instanceof NietGevondenFout) return alsHttp(fout);
      throw fout;
    }
  }

  @Post(':id/status')
  @VereistRecht('begroting.wijzigen')
  async zetStatus(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ): Promise<{ ok: true }> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (
      body.status !== 'voorgesteld_alv' &&
      body.status !== 'vastgesteld' &&
      body.status !== 'gesloten'
    ) {
      throw new BadRequestException(
        'Status moet "voorgesteld_alv", "vastgesteld" of "gesloten" zijn.',
      );
    }
    try {
      await this.#service.zetStatus(vveId, idUit(id, 'begroting-id'), body.status, persoonId);
      return { ok: true };
    } catch (fout: unknown) {
      if (fout instanceof InvoerFout || fout instanceof NietGevondenFout) return alsHttp(fout);
      throw fout;
    }
  }
}
