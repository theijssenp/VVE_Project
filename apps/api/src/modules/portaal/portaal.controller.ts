/**
 * Portaal-endpoints — blok V07 (spec M14 · AC14.1–14.3).
 *
 * Tenant-scoped op de §7.5-keten. Rechten: `portaal.lezen` (het overzicht)
 * en `portaal.gegevens` (eigen gegevens lezen/wijzigen). Geen geldstroom-
 * rechten: het portaal is een leesvenster op de eigen administratie.
 *
 * De persoon-id komt uit het access-token (inlogContext) — een eigenaar kan
 * uitsluitend zijn eigen gegevens zien en wijzigen; er is geen id-parameter.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { DATABASE } from '../../database/database.module.js';
import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../auth/sessie.guard.js';
import { ZodValidationPipe } from '../../gemeenschappelijk/validatie/zod-pipe.js';
import { InvoerFout, NietGevondenFout } from '../../financieel/boekhouding.js';
import { maakPortaalService } from './portaal-service.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null; mfaGeauthenticeerd: boolean };
}

function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

// Nog niet geïmporteerd bovenin: NotFoundException komt uit @nestjs/common
// en staat al in de importlijst van de compiler-check hieronder.

const GEGEVENS_SCHEMA = z
  .object({
    voornaam: z.string().max(100).optional(),
    tussenvoegsel: z.string().max(40).optional(),
    achternaam: z.string().min(1).max(200).optional(),
    telefoon: z.string().max(30).optional(),
    corrStraat: z.string().max(200).optional(),
    corrHuisnummer: z.string().max(20).optional(),
    corrPostcode: z.string().max(12).optional(),
    corrPlaats: z.string().max(100).optional(),
    communicatieWijze: z.enum(['email', 'post', 'beide']).optional(),
  })
  .strict();

type GegevensInvoer = z.infer<typeof GEGEVENS_SCHEMA>;

@Controller('portaal')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class PortaalController {
  readonly #service;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#service = maakPortaalService({ db });
  }

  /** De tenant úit het token; zonder actieve VvE is er geen portaal (§7.5). */
  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  /** M14-startscherm: mijn eenheden, saldo, betalingen, mededelingen. */
  @Get()
  @VereistRecht('portaal.lezen')
  async overzicht(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      return await this.#service.overzicht(vveId, persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC14.3: de eigen gegevens lezen. */
  @Get('gegevens')
  @VereistRecht('portaal.gegevens')
  async gegevens(@Req() verzoek: MetInlog): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new ForbiddenException('Geen sessie.');
    try {
      return await this.#service.gegevens(persoonId);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /** AC14.3: de eigen gegevens wijzigen (zonder e-mail — verificatie volgt). */
  @Patch('gegevens')
  @VereistRecht('portaal.gegevens')
  async wijzigGegevens(
    @Req() verzoek: MetInlog,
    @Body(new ZodValidationPipe(GEGEVENS_SCHEMA))
    body: GegevensInvoer,
  ): Promise<unknown> {
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new ForbiddenException('Geen sessie.');
    const invoer: {
      voornaam?: string;
      tussenvoegsel?: string;
      achternaam?: string;
      telefoon?: string;
      corrStraat?: string;
      corrHuisnummer?: string;
      corrPostcode?: string;
      corrPlaats?: string;
      communicatieWijze?: string;
    } = {};
    if (body.voornaam !== undefined) invoer.voornaam = body.voornaam;
    if (body.tussenvoegsel !== undefined) invoer.tussenvoegsel = body.tussenvoegsel;
    if (body.achternaam !== undefined) invoer.achternaam = body.achternaam;
    if (body.telefoon !== undefined) invoer.telefoon = body.telefoon;
    if (body.corrStraat !== undefined) invoer.corrStraat = body.corrStraat;
    if (body.corrHuisnummer !== undefined) invoer.corrHuisnummer = body.corrHuisnummer;
    if (body.corrPostcode !== undefined) invoer.corrPostcode = body.corrPostcode;
    if (body.corrPlaats !== undefined) invoer.corrPlaats = body.corrPlaats;
    if (body.communicatieWijze !== undefined) invoer.communicatieWijze = body.communicatieWijze;
    try {
      return await this.#service.wijzigGegevens(persoonId, invoer);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
