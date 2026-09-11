/**
 * Bijdrageschema-endpoints — blok G05 (M5 · AC5.2–AC5.5).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `bijdrage.lezen` (detail met
 * dekking) en `bijdrage.wijzigen` (aanmaken, herberekenen, vaste bedragen,
 * statusschuif via het begrotingspatroon). De statusschuif komt in een
 * volgend blok samen met de nota-generatie (G06), die 'vastgesteld' eist.
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
import { maakBijdrageService } from './bijdrage-service.js';

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

@Controller('bijdrageschema')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class BijdrageController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakBijdrageService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Post()
  @VereistRecht('bijdrage.wijzigen')
  async maak(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      boekjaarId?: unknown;
      methode?: unknown;
      periodiciteit?: unknown;
      ingangsdatum?: unknown;
    },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body.boekjaarId !== 'string' || !/^\d+$/.test(body.boekjaarId)) {
      throw new BadRequestException('Veld "boekjaarId" (string-id) is verplicht.');
    }
    if (
      body.methode !== 'uit_begroting' &&
      body.methode !== 'vast_bedrag' &&
      body.methode !== 'vierkante_meters'
    ) {
      throw new BadRequestException(
        'Methode moet "uit_begroting", "vast_bedrag" of "vierkante_meters" zijn.',
      );
    }
    if (
      body.periodiciteit !== 'maand' &&
      body.periodiciteit !== 'kwartaal' &&
      body.periodiciteit !== 'jaar'
    ) {
      throw new BadRequestException('Periodiciteit moet "maand", "kwartaal" of "jaar" zijn.');
    }
    try {
      return await this.#service.maak(
        vveId,
        {
          boekjaarId: BigInt(body.boekjaarId),
          methode: body.methode,
          periodiciteit: body.periodiciteit,
          ingangsdatum: typeof body.ingangsdatum === 'string' ? body.ingangsdatum : '',
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/herbereken')
  @VereistRecht('bijdrage.wijzigen')
  async herbereken(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      return await this.#service.herbereken(vveId, idUit(id, 'schema-id'), persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/vaste-bedragen')
  @VereistRecht('bijdrage.wijzigen')
  async zetVasteBedragen(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { regels?: unknown },
  ): Promise<{ ok: true }> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (!Array.isArray(body.regels) || body.regels.length === 0) {
      throw new BadRequestException('Veld "regels" is een niet-lege lijst verplicht.');
    }
    const regels = (body.regels as unknown[]).map((r) => {
      const rij = r as {
        wooneenheidId?: unknown;
        exploitatieCent?: unknown;
        reservefondsCent?: unknown;
      };
      if (
        typeof r !== 'object' ||
        r === null ||
        typeof rij.wooneenheidId !== 'string' ||
        !/^\d+$/.test(rij.wooneenheidId) ||
        typeof rij.exploitatieCent !== 'number' ||
        typeof rij.reservefondsCent !== 'number'
      ) {
        throw new BadRequestException(
          'Elke regel heeft wooneenheidId (string-id), exploitatieCent en reservefondsCent (numbers) nodig.',
        );
      }
      return {
        wooneenheidId: BigInt(rij.wooneenheidId),
        exploitatieCent: rij.exploitatieCent,
        reservefondsCent: rij.reservefondsCent,
      };
    });
    try {
      await this.#service.zetVasteBedragen(vveId, idUit(id, 'schema-id'), regels, persoonId);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Get(':id')
  @VereistRecht('bijdrage.lezen')
  async detail(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    try {
      return await this.#service.detail(this.#eisTenant(verzoek), idUit(id, 'schema-id'));
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
