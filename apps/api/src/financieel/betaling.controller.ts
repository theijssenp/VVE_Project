/**
 * Betaling-endpoints — blok G08 (M6 · AC6.3, tests #8–#9).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `betaling.lezen` (lijst,
 * notastatus) en `betaling.wijzigen` (registreren met koppelingen).
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
import { maakBetalingService } from './betaling-service.js';

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

@Controller('betalingen')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class BetalingController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakBetalingService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('betaling.lezen')
  async lijst(
    @Req() verzoek: MetInlog,
    @Query('eenheidId') eenheidId: string | undefined,
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const rijen =
      eenheidId === undefined
        ? await this.#service.lijst(vveId)
        : await this.#service.lijst(vveId, idUit(eenheidId, 'eenheid-id'));
    return { betalingen: rijen };
  }

  @Get('notastatus')
  @VereistRecht('betaling.lezen')
  async notastatus(
    @Req() verzoek: MetInlog,
    @Query('eenheidId') eenheidId: string,
  ): Promise<unknown> {
    if (typeof eenheidId !== 'string') {
      throw new BadRequestException('Query "eenheidId" is verplicht.');
    }
    return {
      notas: await this.#service.notastatus(
        this.#eisTenant(verzoek),
        idUit(eenheidId, 'eenheid-id'),
      ),
    };
  }

  @Get('creditsaldo')
  @VereistRecht('betaling.lezen')
  async creditsaldo(
    @Req() verzoek: MetInlog,
    @Query('eenheidId') eenheidId: string | undefined,
  ): Promise<unknown> {
    if (typeof eenheidId !== 'string') {
      throw new BadRequestException('Query "eenheidId" is verplicht.');
    }
    return {
      saldoCenten: await this.#service.creditsaldo(
        this.#eisTenant(verzoek),
        idUit(eenheidId, 'eenheid-id'),
      ),
    };
  }

  @Post()
  @VereistRecht('betaling.wijzigen')
  async registreer(
    @Req() verzoek: MetInlog,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (
      typeof body['datum'] !== 'string' ||
      typeof body['bedragCent'] !== 'number' ||
      typeof body['wooneenheidId'] !== 'string' ||
      !/^\d+$/.test(body['wooneenheidId'])
    ) {
      throw new BadRequestException(
        'Velden datum (string), bedragCent (number) en wooneenheidId (string-id) zijn verplicht.',
      );
    }
    const bron = body['bron'];
    if (
      bron !== 'bank' &&
      bron !== 'kas' &&
      bron !== 'handmatig' &&
      bron !== 'incasso' &&
      bron !== 'verrekening'
    ) {
      throw new BadRequestException(
        'Bron moet "bank", "kas", "handmatig", "incasso" of "verrekening" zijn.',
      );
    }
    if (!Array.isArray(body['koppelingen']) || body['koppelingen'].length === 0) {
      throw new BadRequestException('Veld "koppelingen" is een niet-lege lijst verplicht (AC6.3).');
    }
    const koppelingen = (body['koppelingen'] as unknown[]).map((k) => {
      if (typeof k !== 'object' || k === null) {
        throw new BadRequestException(
          'Elke koppeling heeft notaId (string-id) en bedragCent (number) nodig.',
        );
      }
      const rij = k as { notaId?: unknown; bedragCent?: unknown };
      if (typeof rij.bedragCent !== 'number') {
        throw new BadRequestException(
          'Elke koppeling heeft notaId (string-id) en bedragCent (number) nodig.',
        );
      }
      if (typeof rij.notaId !== 'string' || !/^\d+$/.test(rij.notaId)) {
        throw new BadRequestException(
          'Elke koppeling heeft notaId (string-id) en bedragCent (number) nodig.',
        );
      }
      return { notaId: BigInt(rij.notaId), bedragCent: rij.bedragCent };
    });
    try {
      return await this.#service.registreer(
        vveId,
        {
          datum: body['datum'],
          bedragCent: body['bedragCent'],
          bron,
          wooneenheidId: BigInt(body['wooneenheidId']),
          koppelingen,
          ...(typeof body['omschrijving'] === 'string'
            ? { omschrijving: body['omschrijving'] }
            : {}),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
