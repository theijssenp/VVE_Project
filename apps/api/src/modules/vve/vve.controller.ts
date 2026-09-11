/**
 * VvE-endpoints — blok V01 (spec M1 · AC1.1–1.5).
 *
 * Elke route declareert een recht: zonder `@VereistRecht` start de applicatie
 * niet (§7.5, test #32). De `TenantGuard` staat hier bewust *niet* op — die
 * eist een VvE in het token, en de applicatiebeheerder werkt juist over alle
 * VvE's heen en heeft er zelf geen. De afscherming is daarom expliciet:
 * `#eisApplicatiebeheerder` op elke route.
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
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../../database/database.module.js';
import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { genereerWachtwoord } from '../../gemeenschappelijk/auth/wachtwoord-generator.js';
import type { InlogRequestContext } from '../../gemeenschappelijk/auth/guards.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../auth/sessie.guard.js';
import {
  InvoerFout,
  MODELREGLEMENTEN,
  NietGevondenFout,
  isApplicatiebeheerder,
  maakVveService,
  type BeheerderVelden,
  type VveService,
  type VveVelden,
} from './vve.service.js';

/** Lengte van een voorgesteld wachtwoord; gelijk aan het seed-script. */
const VOORSTEL_LENGTE = 20;

interface MetInlog extends Request {
  inlogContext?: InlogRequestContext;
}

function idUit(waarde: string, veld: string): bigint {
  try {
    return BigInt(waarde);
  } catch {
    throw new BadRequestException(`Ongeldig ${veld}.`);
  }
}

/** Vertaalt de servicefouten naar HTTP; de service kent geen HTTP. */
function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  throw fout;
}

@Controller('vve')
@UseGuards(SessieGuard)
export class VveController {
  readonly #db: NodePgDatabase;
  readonly #service: VveService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#db = db;
    this.#service = maakVveService({ db, klok: new SystemKlok() });
  }

  /** Geeft de persoon-id van de ingelogde applicatiebeheerder terug — het
   * auditlog moet vastleggen wie de handeling deed. */
  async #eisApplicatiebeheerder(verzoek: MetInlog): Promise<bigint> {
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new ForbiddenException('Geen inlogcontext.');
    if (!(await isApplicatiebeheerder(this.#db, persoonId))) {
      throw new ForbiddenException('Alleen de applicatiebeheerder mag VvE-beheer gebruiken.');
    }
    return persoonId;
  }

  /**
   * Een wachtwoordvoorstel uit de CSPRNG van de server. Staat vóór `:id`, anders
   * vangt die route dit pad af.
   *
   * Het voorstel wordt nergens bewaard: het is een suggestie voor het formulier,
   * pas bij het opslaan gaat de hash de database in.
   */
  @Get('wachtwoord-voorstel')
  @VereistRecht('vve.aanmaken')
  async wachtwoordVoorstel(@Req() verzoek: MetInlog): Promise<{ wachtwoord: string }> {
    await this.#eisApplicatiebeheerder(verzoek);
    return { wachtwoord: genereerWachtwoord(VOORSTEL_LENGTE) };
  }

  /** Keuzelijsten voor het formulier. */
  @Get('keuzes')
  @VereistRecht('vve.lezen')
  async keuzes(@Req() verzoek: MetInlog): Promise<{ modelreglementen: readonly string[] }> {
    await this.#eisApplicatiebeheerder(verzoek);
    return { modelreglementen: MODELREGLEMENTEN };
  }

  @Get()
  @VereistRecht('vve.lezen')
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    await this.#eisApplicatiebeheerder(verzoek);
    return this.#service.lijst();
  }

  @Post()
  @VereistRecht('vve.aanmaken')
  async maak(
    @Req() verzoek: MetInlog,
    @Body() body: { vve?: VveVelden; beheerder?: BeheerderVelden },
  ): Promise<{ vveId: bigint; persoonId: bigint }> {
    await this.#eisApplicatiebeheerder(verzoek);
    if (body.vve === undefined || body.beheerder === undefined) {
      throw new BadRequestException('Zowel de VvE-gegevens als de beheerder zijn verplicht.');
    }
    try {
      return await this.#service.maakVve(body.vve, body.beheerder);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Patch(':id')
  @VereistRecht('vve.wijzigen')
  async wijzig(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: Partial<VveVelden>,
  ): Promise<{ ok: true }> {
    await this.#eisApplicatiebeheerder(verzoek);
    try {
      await this.#service.wijzig(idUit(id, 'VvE-id'), body);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/status')
  @VereistRecht('vve.archiveren')
  async zetStatus(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ): Promise<{ ok: true }> {
    const doorPersoonId = await this.#eisApplicatiebeheerder(verzoek);
    if (body.status !== 'actief' && body.status !== 'gearchiveerd') {
      throw new BadRequestException('Status moet "actief" of "gearchiveerd" zijn.');
    }
    try {
      await this.#service.zetStatus(idUit(id, 'VvE-id'), body.status, doorPersoonId);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post(':id/beheerder')
  @VereistRecht('vve.beheerder.toewijzen')
  async voegBeheerderToe(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Body() body: BeheerderVelden,
  ): Promise<{ persoonId: bigint }> {
    await this.#eisApplicatiebeheerder(verzoek);
    try {
      return await this.#service.voegBeheerderToe(idUit(id, 'VvE-id'), body);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  /**
   * AC1.3 — nieuw wachtwoord zetten. Trekt álle sessies van dat account in.
   * De mail die de spec hier noemt vervalt zolang SMTP niet bruikbaar is: de
   * applicatiebeheerder geeft het wachtwoord zelf door.
   */
  @Post(':id/beheerder/:persoonId/wachtwoord')
  @VereistRecht('vve.beheerder.wachtwoord')
  async zetWachtwoord(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
    @Param('persoonId') persoonId: string,
    @Body() body: { wachtwoord?: unknown },
  ): Promise<{ sessiesIngetrokken: number }> {
    const doorPersoonId = await this.#eisApplicatiebeheerder(verzoek);
    if (typeof body.wachtwoord !== 'string') {
      throw new BadRequestException('Veld "wachtwoord" is verplicht.');
    }
    try {
      return await this.#service.zetWachtwoord(
        idUit(id, 'VvE-id'),
        idUit(persoonId, 'persoon-id'),
        body.wachtwoord,
        doorPersoonId,
      );
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
