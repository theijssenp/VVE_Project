/**
 * Aanmaning-endpoints — blok G11 (M6 · AC6.5/AC6.6).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `aanmaning.lezen` (traject) en
 * `aanmaning.versturen` (stap zetten, instellingen) — aparte rechten, want
 * het versturen van een veertiendagenbrief is een juridische handeling.
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
import { maakAanmaningService } from './aanmaning-service.js';

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

@Controller('aanmaningen')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class AanmaningController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakAanmaningService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get(':notaId')
  @VereistRecht('aanmaning.lezen')
  async traject(@Req() verzoek: MetInlog, @Param('notaId') notaId: string): Promise<unknown> {
    try {
      return {
        stappen: await this.#service.traject(this.#eisTenant(verzoek), idUit(notaId, 'nota-id')),
      };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('instellingen')
  @VereistRecht('aanmaning.versturen')
  async instellingen(
    @Req() verzoek: MetInlog,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    const dagen = (veld: string): number | undefined => {
      const waarde = body[veld];
      if (waarde === undefined) return undefined;
      if (typeof waarde !== 'number' || !Number.isInteger(waarde) || waarde < 0) {
        throw new BadRequestException(`Veld "${veld}" moet een niet-negatief geheel getal zijn.`);
      }
      return waarde;
    };
    const grondslag = body['renteGrondslag'];
    if (
      grondslag !== undefined &&
      grondslag !== 'wettelijk' &&
      grondslag !== 'reglementair' &&
      grondslag !== 'geen'
    ) {
      throw new BadRequestException(
        'renteGrondslag moet "wettelijk", "reglementair" of "geen" zijn.',
      );
    }
    const percentage = body['rentePercentage'];
    if (
      percentage !== undefined &&
      (typeof percentage !== 'string' || !/^\d+(\.\d{1,2})?$/.test(percentage))
    ) {
      throw new BadRequestException('rentePercentage moet een tekst als "0" of "6.00" zijn.');
    }
    const herinnering = dagen('herinneringDagen');
    const aanmaningD = dagen('aanmaningDagen');
    const ingebrekestelling = dagen('ingebrekestellingDagen');
    try {
      await this.#service.zetInstellingen(
        this.#eisTenant(verzoek),
        {
          ...(herinnering !== undefined ? { herinneringDagen: herinnering } : {}),
          ...(aanmaningD !== undefined ? { aanmaningDagen: aanmaningD } : {}),
          ...(ingebrekestelling !== undefined ? { ingebrekestellingDagen: ingebrekestelling } : {}),
          ...(grondslag !== undefined ? { renteGrondslag: grondslag } : {}),
          ...(percentage !== undefined ? { rentePercentage: percentage } : {}),
        },
        persoonId,
      );
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':notaId/stap')
  @VereistRecht('aanmaning.versturen')
  async verstuurStap(
    @Req() verzoek: MetInlog,
    @Param('notaId') notaId: string,
    @Body() body: { peildatum?: unknown },
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body.peildatum !== 'string') {
      throw new BadRequestException('Veld "peildatum" (string) is verplicht.');
    }
    try {
      return await this.#service.verstuurStap(
        this.#eisTenant(verzoek),
        idUit(notaId, 'nota-id'),
        body.peildatum,
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
