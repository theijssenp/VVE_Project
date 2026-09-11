/**
 * Verdeelsleutel-endpoints — blok G03 (M4 · AC4.1–AC4.5).
 *
 * Tenant-scoped op de §7.5-keten. Lezen (`verdeelsleutel.lezen`) is nodig
 * voor begroting en bijdrageschema; muteren eist `verdeelsleutel.wijzigen`.
 * De voorbeeldberekening (AC4.4) is een lees-actie met een proefbedrag.
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

import { Bedrag } from '@vve/domein';
import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { maakVerdeelsleutelService } from './verdeelsleutel-service.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

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

/** Regels uit JSON; weigert slechte invoer vroeg (§7.5 stap 4-geest). */
function regelsUit(invoer: unknown): { wooneenheidId: bigint; gewicht: number }[] {
  if (!Array.isArray(invoer)) {
    throw new BadRequestException('Veld "regels" is een lijst verplicht.');
  }
  return invoer.map((r) => {
    if (
      typeof r !== 'object' ||
      r === null ||
      typeof (r as { wooneenheidId?: unknown }).wooneenheidId !== 'string' ||
      typeof (r as { gewicht?: unknown }).gewicht !== 'number'
    ) {
      throw new BadRequestException(
        'Elke regel heeft wooneenheidId (string) en gewicht (number) nodig.',
      );
    }
    const rij = r as { wooneenheidId: string; gewicht: number };
    if (!/^\d+$/.test(rij.wooneenheidId)) {
      throw new BadRequestException('wooneenheidId moet een positief geheel getal zijn.');
    }
    if (rij.gewicht < 0) {
      throw new BadRequestException('Gewicht mag niet negatief zijn (0 = uitgesloten).');
    }
    return { wooneenheidId: BigInt(rij.wooneenheidId), gewicht: rij.gewicht };
  });
}

@Controller('verdeelsleutels')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class VerdeelsleutelController {
  readonly #service: ReturnType<typeof maakVerdeelsleutelService>;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakVerdeelsleutelService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  @Get()
  @VereistRecht('verdeelsleutel.lezen')
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    return this.#service.lijst(this.#eisTenant(verzoek));
  }

  @Get(':id')
  @VereistRecht('verdeelsleutel.lezen')
  async detail(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    try {
      return await this.#service.detail(this.#eisTenant(verzoek), idUit(id, 'sleutel-id'));
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post()
  @VereistRecht('verdeelsleutel.wijzigen')
  async maak(
    @Req() verzoek: MetInlog,
    @Body() body: { naam?: unknown; type?: unknown; omschrijving?: unknown; regels?: unknown },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    if (typeof body.naam !== 'string' || typeof body.type !== 'string') {
      throw new BadRequestException('Velden "naam" en "type" zijn verplicht.');
    }
    try {
      return await this.#service.maak(
        vveId,
        {
          naam: body.naam,
          type: body.type as
            'breukdeel' | 'vierkante_meters' | 'gelijke_delen' | 'stemmen' | 'handmatig',
          omschrijving: typeof body.omschrijving === 'string' ? body.omschrijving : null,
          regels: body.regels === undefined ? undefined : regelsUit(body.regels),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/nieuwe-versie')
  @VereistRecht('verdeelsleutel.wijzigen')
  async nieuweVersie(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { naam?: unknown; omschrijving?: unknown; regels?: unknown },
  ): Promise<unknown> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId ?? 0n;
    try {
      return await this.#service.nieuweVersie(
        vveId,
        idUit(id, 'sleutel-id'),
        {
          naam: typeof body.naam === 'string' ? body.naam : null,
          omschrijving: typeof body.omschrijving === 'string' ? body.omschrijving : null,
          regels: body.regels === undefined ? null : regelsUit(body.regels),
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/voorbeeld')
  @VereistRecht('verdeelsleutel.lezen')
  async voorbeeld(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { proefbedragCenten?: unknown },
  ): Promise<unknown> {
    if (typeof body.proefbedragCenten !== 'number' || body.proefbedragCenten <= 0) {
      throw new BadRequestException('Veld "proefbedragCenten" (positief getal) is verplicht.');
    }
    try {
      return await this.#service.voorbeeldVerdeling(
        this.#eisTenant(verzoek),
        idUit(id, 'sleutel-id'),
        Bedrag.vanCenten(body.proefbedragCenten),
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
