/**
 * Leverancier-endpoints — blok A05 (M12 · AC12.4–AC12.6).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `leverancier.lezen` (register,
 * signaleringen) en `leverancier.wijzigen` (aanmaken, contracten,
 * verplichtingen).
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
import { maakLeverancierService } from './leverancier-service.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null; mfaGeauthenticeerd: boolean };
}

function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

function datum(veld: string, waarde: unknown): string {
  if (typeof waarde !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(waarde)) {
    throw new BadRequestException(`Veld "${veld}" moet de vorm YYYY-MM-DD hebben.`);
  }
  return waarde;
}

@Controller('leveranciers')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class LeverancierController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakLeverancierService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('leverancier.lezen')
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    return { leveranciers: await this.#service.lijst(this.#eisTenant(verzoek)) };
  }

  @Post()
  @VereistRecht('leverancier.wijzigen')
  async maak(@Req() verzoek: MetInlog, @Body() body: Record<string, unknown>): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body['naam'] !== 'string' || body['naam'].trim() === '') {
      throw new BadRequestException('Veld "naam" (string) is verplicht.');
    }
    try {
      return await this.#service.maakLeverancier(
        this.#eisTenant(verzoek),
        {
          naam: body['naam'],
          ...(typeof body['contactpersoon'] === 'string'
            ? { contactpersoon: body['contactpersoon'] }
            : {}),
          ...(typeof body['email'] === 'string' ? { email: body['email'] } : {}),
          ...(typeof body['telefoon'] === 'string' ? { telefoon: body['telefoon'] } : {}),
          ...(typeof body['kvkNummer'] === 'string' ? { kvkNummer: body['kvkNummer'] } : {}),
          ...(typeof body['opmerking'] === 'string' ? { opmerking: body['opmerking'] } : {}),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('contracten')
  @VereistRecht('leverancier.wijzigen')
  async contract(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      leverancierId?: unknown;
      omschrijving?: unknown;
      bedragPerJaarCent?: unknown;
      startDatum?: unknown;
      eindDatum?: unknown;
      opzegtermijnDagen?: unknown;
    },
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (
      typeof body.leverancierId !== 'string' ||
      !/^\d+$/.test(body.leverancierId) ||
      typeof body.omschrijving !== 'string' ||
      typeof body.bedragPerJaarCent !== 'number'
    ) {
      throw new BadRequestException(
        'Velden leverancierId (string-id), omschrijving (string) en bedragPerJaarCent (number) zijn verplicht.',
      );
    }
    if (
      body.opzegtermijnDagen !== undefined &&
      (typeof body.opzegtermijnDagen !== 'number' || body.opzegtermijnDagen < 0)
    ) {
      throw new BadRequestException('opzegtermijnDagen moet een niet-negatief geheel getal zijn.');
    }
    try {
      return await this.#service.voegContractToe(
        this.#eisTenant(verzoek),
        {
          leverancierId: BigInt(body.leverancierId),
          omschrijving: body.omschrijving,
          bedragPerJaarCent: body.bedragPerJaarCent,
          startDatum: datum('startDatum', body.startDatum),
          ...(body.eindDatum !== undefined && body.eindDatum !== null
            ? { eindDatum: datum('eindDatum', body.eindDatum) }
            : {}),
          ...(body.opzegtermijnDagen !== undefined
            ? { opzegtermijnDagen: body.opzegtermijnDagen }
            : {}),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Get('contracten')
  @VereistRecht('leverancier.lezen')
  async contracten(@Req() verzoek: MetInlog): Promise<unknown> {
    return { leveranciers: await this.#service.contracten(this.#eisTenant(verzoek)) };
  }

  @Post('verplichtingen')
  @VereistRecht('leverancier.wijzigen')
  async verplichting(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      leverancierId?: unknown;
      soort?: unknown;
      omschrijving?: unknown;
      vervaldatum?: unknown;
    },
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    const soort = body.soort;
    if (
      soort !== 'liftkeuring' &&
      soort !== 'brandmeldinstallatie' &&
      soort !== 'legionella' &&
      soort !== 'nen3140' &&
      soort !== 'opstalverzekering' &&
      soort !== 'aansprakelijkheid' &&
      soort !== 'bestuurdersaansprakelijkheid' &&
      soort !== 'rechtsbijstand' &&
      soort !== 'energielabel' &&
      soort !== 'overig'
    ) {
      throw new BadRequestException(
        'soort moet een geldige verplichtingssoort zijn (liftkeuring, brandmeldinstallatie, …).',
      );
    }
    const soortGeldig:
      | 'liftkeuring'
      | 'brandmeldinstallatie'
      | 'legionella'
      | 'nen3140'
      | 'opstalverzekering'
      | 'aansprakelijkheid'
      | 'bestuurdersaansprakelijkheid'
      | 'rechtsbijstand'
      | 'energielabel'
      | 'overig' = soort;
    if (typeof body.omschrijving !== 'string' || body.omschrijving === '') {
      throw new BadRequestException('Veld "omschrijving" (string) is verplicht.');
    }
    if (
      body.leverancierId !== undefined &&
      (typeof body.leverancierId !== 'string' || !/^\d+$/.test(body.leverancierId))
    ) {
      throw new BadRequestException('leverancierId moet een string-id zijn.');
    }
    try {
      return await this.#service.voegVerplichtingToe(
        this.#eisTenant(verzoek),
        {
          ...(body.leverancierId !== undefined
            ? { leverancierId: BigInt(body.leverancierId) }
            : {}),
          soort: soortGeldig,
          omschrijving: body.omschrijving,
          vervaldatum: datum('vervaldatum', body.vervaldatum),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Get('verplichtingen')
  @VereistRecht('leverancier.lezen')
  async verplichtingen(@Req() verzoek: MetInlog): Promise<unknown> {
    return { verplichtingen: await this.#service.verplichtingen(this.#eisTenant(verzoek)) };
  }
}
