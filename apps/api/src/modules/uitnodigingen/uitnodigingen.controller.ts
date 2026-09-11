/**
 * Uitnodigingen-endpoints — blok V04 (spec §3.3, AC2.2).
 *
 * Beheerderskant: uitnodigen, opnieuw versturen en de lijst — tenant-scoped op
 * de §7.5-guardketen (de tenant komt uit het token). Registratiekant: het
 * token-uitwisselendpunt, bewust zónder SessieGuard — de persoon die registreert
 * heeft nog geen account; het ééndegligige opake token ís de autorisatie, en
 * wordt in de service in dezelfde transactie geconsumeerd (one-time use, §3.3).
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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../../database/database.module.js';
import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../../gemeenschappelijk/auth/tenant-guards.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';
import { SessieGuard } from '../auth/sessie.guard.js';
import {
  InvoerFout,
  NietGevondenFout,
  OngeldigTokenFout,
  maakUitnodigingenService,
  type UitnodigingenService,
  type UitnodigingVerzoek,
} from './uitnodigingen.service.js';
import {
  maakMailService,
  type MailServiceInterface,
} from '../../gemeenschappelijk/mail/mail-service.js';

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

/** Vertaalt de servicefouten naar HTTP; de service kent geen HTTP. */
function alsHttp(fout: unknown): never {
  if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
  if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
  if (fout instanceof OngeldigTokenFout) throw new UnauthorizedException(fout.message);
  throw fout;
}

/**
 * De SMTP-verzender van F10. In dit blok nog een stub die de tekst in het
 * log schrijft; de echte nodemailer-transport volgt bij de livegang (de
 * wachtrij zelf is al hetzelfde pad). Tests injecteren hun eigen verzender.
 */
class LogVerzender {
  verzend(bericht: {
    readonly ontvangerEmail: string;
    readonly onderwerp: string;
    readonly tekst: string;
  }): Promise<void> {
    // Bewust geen geheim in het log: de registratielink hoort daar niet.
    console.log(
      `[mail] aan ${bericht.ontvangerEmail}: ${bericht.onderwerp} (${String(bericht.tekst.length)} tekens, wachtrij verzendt via SMTP zodra die is aangesloten)`,
    );
    return Promise.resolve();
  }
}

function registratieBasis(): string {
  const basis = process.env['REGISTRATIE_BASIS'] ?? 'http://localhost:8100/registratie';
  return basis;
}

@Controller()
export class UitnodigingenController {
  readonly #service: UitnodigingenService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    const klok = new SystemKlok();
    const verzender = new LogVerzender();
    const mail: MailServiceInterface = maakMailService({ db, verzender });
    this.#service = maakUitnodigingenService({
      db,
      mail,
      klok,
      registratieBasis: registratieBasis(),
    });
  }

  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  @Post('vve-mij/uitnodigingen')
  @VereistRecht('uitnodiging.verstuur')
  @UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
  async nodigUit(
    @Req() verzoek: MetInlog,
    @Body() body: { email?: unknown; eenheidId?: unknown; rol?: unknown },
  ): Promise<unknown> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    if (typeof body.email !== 'string') {
      throw new BadRequestException('Veld "email" is verplicht.');
    }
    const verzoekVelden: UitnodigingVerzoek = {
      email: body.email,
      eenheidId: typeof body.eenheidId === 'string' ? idUit(body.eenheidId, 'eenheid-id') : null,
      rol: body.rol === 'bewoner' ? 'bewoner' : 'eigenaar',
    };
    try {
      const uit = await this.#service.nodigUit(vveId, verzoekVelden, persoonId);
      // Het ruwe token gaat nooit naar de client van de beheerder; het
      // verlaat de service alleen in de mail. De beheerder ziet de status.
      return { uitnodigingId: uit.uitnodigingId, bestaandPersoon: uit.bestaandPersoon };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Post('vve-mij/uitnodigingen/:id/opnieuw')
  @VereistRecht('uitnodiging.her_verstuur')
  @UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
  async verstuurOpnieuw(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<{ ok: true }> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    try {
      await this.#service.verstuurOpnieuw(vveId, idUit(id, 'uitnodiging-id'), persoonId);
      return { ok: true };
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }

  @Get('vve-mij/uitnodigingen')
  @VereistRecht('uitnodiging.lezen')
  @UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
  async lijst(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return this.#service.lijst(vveId);
  }

  /**
   * Registratie: het token uit de mail inwisselen voor een account. Geen
   * sessie; het token is de context. Uniforme fout voor onbekend/verlopen/
   * gebruikt — bestaan van een token is zelf al informatie (§7.5-geest).
   */
  @Post('registratie')
  @VereistRecht('registratie.activeer')
  async registreer(@Body() body: { token?: unknown; wachtwoord?: unknown }): Promise<unknown> {
    if (typeof body.token !== 'string' || body.token === '') {
      throw new BadRequestException('Veld "token" is verplicht.');
    }
    if (typeof body.wachtwoord !== 'string') {
      throw new BadRequestException('Veld "wachtwoord" is verplicht.');
    }
    try {
      return await this.#service.registreer(body.token, body.wachtwoord);
    } catch (fout: unknown) {
      return alsHttp(fout);
    }
  }
}
