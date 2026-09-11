/**
 * Auth-endpoints — inloggen, verversen, uitloggen, tweede factor, apparatenlijst.
 *
 * Het refresh-token gaat als **httpOnly-cookie** terug en komt daar ook weer
 * vandaan: de client ziet hem nooit en kan hem dus niet lekken via een XSS-fout
 * (§7.6). Het access-token gaat wél in het antwoord — dat leeft in het geheugen
 * van de client en is vijftien minuten geldig.
 *
 * De inlog- en versversendpoints staan bewust zonder `AuthGuard`: je hebt er nog
 * geen geldig token. Ze declareren wél een recht, want een route zonder
 * declaratie laat de applicatie niet starten (§7.5, test #32).
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../../database/database.module.js';
import { VereistRecht } from '../../gemeenschappelijk/auth/vereist-recht.js';
import { SessieGuard } from './sessie.guard.js';
import {
  AccountGeblokkeerdFout,
  OnbekendPersoonFout,
  OnjuisteInloggegevensFout,
  maakInlogService,
  type InlogService,
  type Profiel,
} from '../../gemeenschappelijk/auth/inlog.js';
import { maakTokenService, type TokenService } from '../../gemeenschappelijk/auth/token.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';

/** Naam van de cookie met het refresh-token. */
const REFRESH_COOKIE = 'vve_refresh';

/**
 * Cookie-instellingen. `secure` staat alleen aan buiten ontwikkeling: op
 * `http://localhost` zou de browser een `Secure`-cookie weigeren te zetten en
 * zou inloggen lokaal niet werken.
 *
 * `sameSite: 'strict'` betekent dat een andere site deze cookie niet meestuurt,
 * ook niet bij een POST. Dat dekt het CSRF-risico op het versversendpoint af;
 * de dubbele-submit-variant uit §7.6 is daarmee nog niet gebouwd en blijft een
 * openstaand punt zolang er statuswijzigende endpoints bijkomen.
 */
function cookieOpties(maxAgeMs: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: maxAgeMs,
  };
}

const REFRESH_DAGEN = 30;
const DAG_MS = 24 * 60 * 60 * 1000;

interface InlogBody {
  readonly email?: unknown;
  readonly wachtwoord?: unknown;
  readonly client?: unknown;
}

/**
 * Bouwt een object zonder de velden die leeg zijn. Nodig omdat
 * `exactOptionalPropertyTypes` een expliciete `undefined` niet accepteert voor
 * een optioneel veld — en dat is precies wat `req.ip` of een ontbrekende
 * user-agent oplevert.
 */
function zonderLege<T extends Record<string, unknown>>(
  velden: T,
): {
  [K in keyof T]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(
    Object.entries(velden).filter(([, waarde]) => waarde !== undefined && waarde !== ''),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function tekst(waarde: unknown, veld: string): string {
  if (typeof waarde !== 'string' || waarde.trim() === '') {
    throw new UnauthorizedException(`Veld ${veld} ontbreekt`);
  }
  return waarde;
}

@Controller('auth')
export class AuthController {
  readonly #tokens: TokenService;
  readonly #inlog: InlogService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    const klok = new SystemKlok();
    this.#tokens = maakTokenService({ db, klok, refreshDagen: REFRESH_DAGEN });
    this.#inlog = maakInlogService({ db, tokens: this.#tokens, klok });
  }

  @Post('inloggen')
  @VereistRecht('auth.inloggen')
  async inloggen(
    @Body() body: InlogBody,
    @Req() verzoek: Request,
    @Res({ passthrough: true }) antwoord: Response,
  ): Promise<{ accessToken: string; mfaVereist: boolean }> {
    const email = tekst(body.email, 'email');
    const wachtwoord = tekst(body.wachtwoord, 'wachtwoord');
    try {
      const uit = await this.#inlog.inlog(
        email,
        wachtwoord,
        zonderLege({
          platform: typeof body.client === 'string' ? body.client : undefined,
          ip: verzoek.ip,
          userAgent: verzoek.get('user-agent'),
        }),
      );
      antwoord.cookie(REFRESH_COOKIE, uit.refreshToken, cookieOpties(REFRESH_DAGEN * DAG_MS));
      return { accessToken: uit.accessToken, mfaVereist: false };
    } catch (fout: unknown) {
      if (fout instanceof OnjuisteInloggegevensFout || fout instanceof AccountGeblokkeerdFout) {
        // Eén melding voor beide gevallen naar buiten (§7.6).
        throw new UnauthorizedException(fout.message);
      }
      throw fout;
    }
  }

  @Post('verversen')
  @VereistRecht('auth.verversen')
  async verversen(
    @Req() verzoek: Request,
    @Res({ passthrough: true }) antwoord: Response,
  ): Promise<{ accessToken: string }> {
    const ruw: unknown = (verzoek.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    if (typeof ruw !== 'string' || ruw === '') {
      throw new UnauthorizedException('Geen sessie');
    }
    try {
      const uit = await this.#tokens.verfris(
        ruw,
        zonderLege({ ip: verzoek.ip, userAgent: verzoek.get('user-agent') }),
      );
      antwoord.cookie(REFRESH_COOKIE, uit.refreshToken, cookieOpties(REFRESH_DAGEN * DAG_MS));
      return { accessToken: uit.accessToken };
    } catch {
      // Ook bij hergebruikdetectie: de sessie is voorbij, de cookie mag weg.
      antwoord.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw new UnauthorizedException('Sessie verlopen');
    }
  }

  @Post('uitloggen')
  @VereistRecht('auth.uitloggen')
  async uitloggen(
    @Req() verzoek: Request,
    @Res({ passthrough: true }) antwoord: Response,
  ): Promise<{ uitgelogd: boolean }> {
    const ruw: unknown = (verzoek.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    antwoord.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    if (typeof ruw === 'string' && ruw !== '') {
      // Alleen dit apparaat; de andere sessies van deze persoon blijven staan.
      await this.#tokens.trekSessieInViaToken(ruw);
    }
    return { uitgelogd: true };
  }

  @Get('apparaten')
  @VereistRecht('auth.apparaten')
  @UseGuards(SessieGuard)
  apparaten(
    @Req() verzoek: Request & { inlogContext?: { persoonId: bigint } },
  ): Promise<unknown[]> {
    // De AuthGuard zet `inlogContext` op het verzoek (§7.5 stap 1).
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new UnauthorizedException();
    return this.#inlog.apparaten(persoonId);
  }

  /**
   * Wie ben ik — de client kiest hiermee zijn startscherm (§9: twee schillen).
   *
   * Bewust een endpoint en geen claim in het access-token: rollen in een token
   * zijn de rollen van het moment van uitgifte. Een beheerder die zojuist is
   * ontheven, zou met zijn lopende token nog een beheerscherm openen. Dit
   * antwoord is per definitie vers, en autoriseert zelf niets — elke route
   * houdt zijn eigen controle.
   */
  @Get('mij')
  @VereistRecht('auth.mij')
  @UseGuards(SessieGuard)
  async mij(@Req() verzoek: Request & { inlogContext?: { persoonId: bigint } }): Promise<Profiel> {
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new UnauthorizedException();
    try {
      return await this.#inlog.profiel(persoonId);
    } catch (fout: unknown) {
      // Geldig token, ingetrokken account: uitloggen, niet "er ging iets mis".
      if (fout instanceof OnbekendPersoonFout) throw new UnauthorizedException(fout.message);
      throw fout;
    }
  }
}
