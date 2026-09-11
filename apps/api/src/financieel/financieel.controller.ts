/**
 * Financiële endpoints — blok G02 (boekjaar + boekingsservice).
 *
 * De boekingsservice is bewust geen HTTP: zij wordt door latere blokken
 * (G06-nota's, B05-afletteren) uit hun eigen services aangeroepen. Hier
 * alleen het beheer rondom: boekjaar openen/afsluiten (AC9.3) en een
 * memoriaal-boeking (de eerste menselijke boeking; nota/bank/incasso volgen
 * in hun eigen blokken). Financieel = geldstroomachtig: de rechten hier zijn
 * bewust níét op de geldstroomlijst (§8.5) — die noemt alleen incasso/IBAN/
 * mandaat/boekjaar-afsluiten/gebruikersrollen. 'boekjaar.afsluiten' ís een
 * geldstroomrecht (herauthenticatie vereist) en staat al in de lijst.
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
import {
  InvoerFout,
  NietGevondenFout,
  OnbalansFout,
  Regel,
  maakBoekhouding,
  type Boekhouding,
} from './boekhouding.js';
import {
  InvoerFout as JaarInvoerFout,
  NietGevondenFout as JaarNietGevondenFout,
  maakBoekjaarService,
  type BoekjaarService,
} from './boekjaar-service.js';

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
  if (fout instanceof InvoerFout || fout instanceof JaarInvoerFout) {
    throw new BadRequestException(fout.message);
  }
  if (fout instanceof NietGevondenFout || fout instanceof JaarNietGevondenFout) {
    throw new NotFoundException(fout.message);
  }
  if (fout instanceof OnbalansFout) throw new BadRequestException(fout.message);
  throw fout;
}

interface RegelInvoer {
  readonly rekeningNummer?: unknown;
  readonly bedragCenten?: unknown;
  readonly kant?: unknown;
  readonly wooneenheidId?: unknown;
  readonly omschrijving?: unknown;
}

/** Vertaalt de JSON-regels naar domein-Regels; weigert slechte invoer vroeg. */
function regelsUit(invoer: unknown): Regel[] {
  if (!Array.isArray(invoer) || invoer.length === 0) {
    throw new BadRequestException('Veld "regels" is een niet-lege lijst verplicht.');
  }
  return invoer.map((r) => {
    const regel = r as RegelInvoer;
    if (
      typeof r !== 'object' ||
      r === null ||
      typeof regel.rekeningNummer !== 'string' ||
      typeof regel.bedragCenten !== 'number' ||
      (regel.kant !== 'debet' && regel.kant !== 'credit')
    ) {
      throw new BadRequestException(
        'Elke regel heeft rekeningNummer (string), bedragCenten (number) en kant ("debet"|"credit") nodig.',
      );
    }
    const opties: { wooneenheidId?: bigint; omschrijving?: string } = {};
    if (typeof regel.wooneenheidId === 'string' && /^\d+$/.test(regel.wooneenheidId)) {
      opties.wooneenheidId = BigInt(regel.wooneenheidId);
    }
    if (typeof regel.omschrijving === 'string') opties.omschrijving = regel.omschrijving;
    return regel.kant === 'debet'
      ? Regel.debet(regel.rekeningNummer, Bedrag.vanCenten(regel.bedragCenten), opties)
      : Regel.credit(regel.rekeningNummer, Bedrag.vanCenten(regel.bedragCenten), opties);
  });
}

@Controller('financieel')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class FinancieelController {
  readonly #boekjaar: BoekjaarService;
  readonly #boekhouding: Boekhouding;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#boekjaar = maakBoekjaarService({ db });
    this.#boekhouding = maakBoekhouding({ db });
  }

  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  @Get('boekjaren')
  @VereistRecht('boekjaar.lezen')
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return this.#boekjaar.lijst(vveId);
  }

  @Post('boekjaren')
  @VereistRecht('boekjaar.aanmaken')
  async maakBoekjaar(
    @Req() verzoek: MetInlog,
    @Body() body: { jaar?: unknown; startDatum?: unknown; eindDatum?: unknown },
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    if (typeof body.jaar !== 'number') {
      throw new BadRequestException('Veld "jaar" (number) is verplicht.');
    }
    try {
      return await this.#boekjaar.maakBoekjaar(
        vveId,
        {
          jaar: body.jaar,
          startDatum: body.startDatum as string,
          eindDatum: body.eindDatum as string,
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('boekjaren/:id/openen')
  @VereistRecht('boekjaar.openen')
  async open(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<{ ok: true }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      await this.#boekjaar.open(vveId, idUit(id, 'boekjaar-id'), persoonId);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /**
   * AC9.3: afsluiten. Recht is op de geldstroomlijst — de RolGuard eist hier
   * MFA-herauthenticatie (§7.6: "boekjaar afsluiten").
   */
  @Post('boekjaren/:id/afsluiten')
  @VereistRecht('boekjaar.afsluiten')
  async afsluiten(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      return await this.#boekjaar.afsluiten(vveId, idUit(id, 'boekjaar-id'), persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /**
   * Memoriale boeking — de menselijke ingang van de boekingsservice. Nota's,
   * betalingen en bankmutaties boeken via hun eigen blokken; het recht hier
   * is bewust apart ('boeking.memoriaal').
   */
  @Post('boekingen')
  @VereistRecht('boeking.memoriaal')
  async boek(
    @Req() verzoek: MetInlog,
    @Body()
    body: {
      boekjaarId?: unknown;
      datum?: unknown;
      omschrijving?: unknown;
      bron?: unknown;
      bronId?: unknown;
      regels?: unknown;
    },
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    if (typeof body.boekjaarId !== 'string') {
      throw new BadRequestException('Veld "boekjaarId" is verplicht.');
    }
    if (typeof body.datum !== 'string' || typeof body.omschrijving !== 'string') {
      throw new BadRequestException('Velden "datum" en "omschrijving" zijn verplicht.');
    }
    const bron = typeof body.bron === 'string' ? body.bron : 'memoriaal';
    const regels = regelsUit(body.regels);
    try {
      return await this.#boekhouding.boek(
        vveId,
        idUit(body.boekjaarId, 'boekjaar-id'),
        {
          datum: body.datum,
          omschrijving: body.omschrijving,
          bron: bron as
            | 'nota'
            | 'betaling'
            | 'bank'
            | 'incasso'
            | 'memoriaal'
            | 'openingsbalans'
            | 'jaarafsluiting',
          bronId:
            typeof body.bronId === 'string' && /^\d+$/.test(body.bronId)
              ? BigInt(body.bronId)
              : null,
          regels,
        },
        persoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
