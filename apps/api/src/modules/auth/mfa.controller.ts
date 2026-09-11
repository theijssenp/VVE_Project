/**
 * MFA-endpoints — blok F07 (spec §7.6, §8.5).
 *
 * De servicelaag van F07 (TOTP, herstelcodes, passkeys, de MFA-poort) bestond
 * al en was getest, maar had geen enkele HTTP-kant: niemand kon een tweede
 * factor activeren, en daarmee was elk recht uit `GELDSTROOM_RECHTEN` — onder
 * meer `boekjaar.afsluiten` — voor iedereen onbereikbaar. Zie het
 * controlelogboek, bevindingen B-01 t/m B-03.
 *
 * **MFA is een step-up, geen inlogpoort.** Dat volgt uit §7.6: de eis hangt aan
 * het *recht*, niet aan de sessie. Wie is ingelogd mag het portaal in; pas een
 * geldstroomhandeling vraagt om de tweede factor. Het access-token draagt
 * daarna de `mfa`-claim, waarop de RolGuard doorlaat.
 *
 * **Waarom alles achter de SessieGuard staat**, ook de passkey-authenticatie:
 * de tweede factor volgt hier altijd op een geslaagde wachtwoordinlog, dus de
 * persoon is al bekend. Dat scheelt het hele pad waarin een onbekende bezoeker
 * WebAuthn-opties opvraagt — en dat pad is precies waar
 * gebruikersopsomming op de loer ligt.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
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
import { SessieGuard } from './sessie.guard.js';
import { SystemKlok } from '../../gemeenschappelijk/system-klok.js';
import { maakMfaGate, type MfaGate } from '../../gemeenschappelijk/auth/mfa-gate.js';
import {
  PasskeyNietGevondenFout,
  PasskeyVerificatieFout,
  maakPasskeyService,
} from '../../gemeenschappelijk/auth/passkey.js';
import {
  OnGeldigeTotpCodeFout,
  OnjuisteHerstelcodeFout,
  TotpNietGeactiveerdFout,
  maakTotpService,
  type TotpService,
} from '../../gemeenschappelijk/auth/totp.js';
import { maakTokenService, type TokenService } from '../../gemeenschappelijk/auth/token.js';
import { persoon } from '../../database/schema/persoon.js';
import { eq } from 'drizzle-orm';

/** Zelfde cookienaam als in `auth.controller.ts` — één sessie, één cookie. */
const REFRESH_COOKIE = 'vve_refresh';
const REFRESH_DAGEN = 30;

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint };
}

/**
 * Relying Party voor WebAuthn. Geen standaardwaarden: een verkeerd `rpId` of
 * `origin` maakt passkeys stil onbruikbaar of — erger — bruikbaar vanaf een
 * domein dat niet van ons is. Ontbreekt de configuratie, dan falen alleen de
 * passkey-routes, niet de hele applicatie: TOTP moet blijven werken.
 */
function rpConfig(): { rpId: string; rpNaam: string; origin: string } {
  const rpId = process.env['WEBAUTHN_RP_ID'];
  const origin = process.env['WEBAUTHN_ORIGIN'];
  if (rpId === undefined || rpId === '' || origin === undefined || origin === '') {
    throw new BadRequestException(
      'Passkeys zijn op deze server niet geconfigureerd (WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN). Gebruik TOTP.',
    );
  }
  return { rpId, rpNaam: process.env['WEBAUTHN_RP_NAAM'] ?? 'VvE-beheer', origin };
}

function isRecord(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null;
}

@Controller('auth/mfa')
@UseGuards(SessieGuard)
export class MfaController {
  readonly #db: NodePgDatabase;
  readonly #totp: TotpService;
  readonly #gate: MfaGate;
  readonly #tokens: TokenService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#db = db;
    this.#totp = maakTotpService({ db });
    this.#gate = maakMfaGate({ db });
    this.#tokens = maakTokenService({ db, klok: new SystemKlok(), refreshDagen: REFRESH_DAGEN });
  }

  #persoonId(verzoek: MetInlog): bigint {
    const id = verzoek.inlogContext?.persoonId;
    if (id === undefined) throw new UnauthorizedException();
    return id;
  }

  #refreshToken(verzoek: Request): string {
    const ruw: unknown = (verzoek.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    if (typeof ruw !== 'string' || ruw === '') {
      throw new UnauthorizedException('Geen sessie');
    }
    return ruw;
  }

  async #email(persoonId: bigint): Promise<string> {
    const [rij] = await this.#db
      .select({ email: persoon.email })
      .from(persoon)
      .where(eq(persoon.id, persoonId))
      .limit(1);
    if (rij === undefined) throw new UnauthorizedException();
    return rij.email;
  }

  /** Wat heeft dit account aan tweede factoren — voor het scherm, niet als poort. */
  @Get()
  @VereistRecht('auth.mfa.status')
  async status(
    @Req() verzoek: MetInlog,
  ): Promise<{ actief: boolean; totp: boolean; passkeys: number }> {
    const persoonId = this.#persoonId(verzoek);
    const [rij] = await this.#db
      .select({ totp: persoon.totpSecretVersleuteld })
      .from(persoon)
      .where(eq(persoon.id, persoonId))
      .limit(1);
    let passkeys = 0;
    try {
      passkeys = (await maakPasskeyService({ db: this.#db, ...rpConfig() }).lijst(persoonId))
        .length;
    } catch {
      // Zonder RP-configuratie zijn er geen passkeys te tellen; TOTP telt nog wel.
      passkeys = 0;
    }
    return {
      actief: await this.#gate.heeftMfa(persoonId),
      totp: (rij?.totp ?? null) !== null,
      passkeys,
    };
  }

  /**
   * Activeert TOTP en geeft het secret, de otpauth-URI en de herstelcodes
   * **één keer** terug. Daarna zijn ze niet meer op te vragen: in de database
   * staat het secret versleuteld en staan de herstelcodes gehasht.
   *
   * Let op de volgorde: `activeer` zet MFA meteen aan, ook als de gebruiker het
   * secret nooit in zijn app zet. Dat is bewust hetzelfde patroon als de
   * wachtwoorduitgifte in V01 — de gegevens worden één keer getoond en de
   * applicatiebeheerder kan opnieuw uitgeven — maar het betekent wél dat
   * wegklikken van dit scherm zonder noteren de geldstroomrechten op slot zet
   * tot een nieuwe activatie.
   */
  @Post('totp')
  @VereistRecht('auth.mfa.activeer')
  async activeerTotp(
    @Req() verzoek: MetInlog,
  ): Promise<{ secret: string; otpauth: string; herstelcodes: string[] }> {
    const persoonId = this.#persoonId(verzoek);
    const email = await this.#email(persoonId);
    const { secret } = await this.#totp.activeer(persoonId, email);
    const herstelcodes = await this.#totp.genereerHerstelcodes(persoonId);
    const uitgever = encodeURIComponent(process.env['WEBAUTHN_RP_NAAM'] ?? 'VvE-beheer');
    const label = encodeURIComponent(email);
    return {
      secret,
      otpauth: `otpauth://totp/${uitgever}:${label}?secret=${secret}&issuer=${uitgever}`,
      herstelcodes,
    };
  }

  /**
   * De step-up zelf: een TOTP-code of een herstelcode wisselt de sessie in voor
   * een access-token mét de `mfa`-claim. Dit is het endpoint dat de client na
   * het inloggen aanroept (`POST /api/auth/mfa`).
   */
  @Post()
  @VereistRecht('auth.mfa.verifieer')
  async verifieer(
    @Req() verzoek: MetInlog,
    @Body() body: { code?: unknown; herstelcode?: unknown },
  ): Promise<{ accessToken: string }> {
    const persoonId = this.#persoonId(verzoek);
    const refreshToken = this.#refreshToken(verzoek);

    const code = typeof body.code === 'string' ? body.code.trim() : null;
    const herstelcode = typeof body.herstelcode === 'string' ? body.herstelcode.trim() : null;
    if (code === null && herstelcode === null) {
      throw new BadRequestException('Geef een code of een herstelcode.');
    }

    let gelukt = false;
    if (herstelcode !== null) {
      try {
        gelukt = await this.#totp.verbruikHerstelcode(persoonId, herstelcode);
      } catch (fout: unknown) {
        // Een onbekende of reeds verbruikte code is een gewone afwijzing, geen
        // storing. Zonder deze vangst werd de tweede poging een 500 — en dat
        // vertelt een aanvaller dat de code ooit bestaan heeft.
        if (fout instanceof OnjuisteHerstelcodeFout) gelukt = false;
        else throw fout;
      }
    } else if (code !== null) {
      try {
        gelukt = await this.#totp.verifieer(persoonId, code);
      } catch (fout: unknown) {
        if (fout instanceof TotpNietGeactiveerdFout) {
          throw new BadRequestException('Er is geen tweede factor ingesteld voor dit account.');
        }
        if (fout instanceof OnGeldigeTotpCodeFout) gelukt = false;
        else throw fout;
      }
    }
    // Eén melding voor "verkeerde code" en "verbruikte herstelcode": het
    // verschil vertelt een aanvaller welke codes ooit bestaan hebben.
    if (!gelukt) throw new UnauthorizedException('Code onjuist of verlopen.');

    return this.#tokens.markeerMfaGeauthenticeerd(persoonId, refreshToken);
  }

  @Post('passkey/registratie-opties')
  @VereistRecht('auth.mfa.passkey.registreer')
  async passkeyRegistratieOpties(@Req() verzoek: MetInlog): Promise<Record<string, unknown>> {
    const persoonId = this.#persoonId(verzoek);
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    return dienst.registratieOpties(persoonId, await this.#email(persoonId));
  }

  @Post('passkey/registratie')
  @VereistRecht('auth.mfa.passkey.registreer')
  async passkeyRegistratie(
    @Req() verzoek: MetInlog,
    @Body() body: { apparaatNaam?: unknown; antwoord?: unknown },
  ): Promise<{ geregistreerd: boolean; credentialId: string }> {
    const persoonId = this.#persoonId(verzoek);
    if (!isRecord(body.antwoord)) throw new BadRequestException('Veld "antwoord" ontbreekt.');
    const apparaatNaam = typeof body.apparaatNaam === 'string' ? body.apparaatNaam : 'Onbekend';
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    try {
      return await dienst.verifieerRegistratie(persoonId, apparaatNaam, body.antwoord);
    } catch (fout: unknown) {
      if (fout instanceof PasskeyVerificatieFout) throw new BadRequestException(fout.message);
      throw fout;
    }
  }

  @Post('passkey/opties')
  @VereistRecht('auth.mfa.verifieer')
  async passkeyOpties(@Req() verzoek: MetInlog): Promise<Record<string, unknown>> {
    const persoonId = this.#persoonId(verzoek);
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    return dienst.authenticatieOpties(await this.#email(persoonId));
  }

  /** Passkey als tweede factor; levert hetzelfde `mfa`-token als TOTP. */
  @Post('passkey')
  @VereistRecht('auth.mfa.verifieer')
  async passkeyVerifieer(
    @Req() verzoek: MetInlog,
    @Body() body: { antwoord?: unknown },
  ): Promise<{ accessToken: string }> {
    const persoonId = this.#persoonId(verzoek);
    const refreshToken = this.#refreshToken(verzoek);
    if (!isRecord(body.antwoord)) throw new BadRequestException('Veld "antwoord" ontbreekt.');
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    let uit: { persoonId: bigint };
    try {
      uit = await dienst.verifieerAuthenticatie(await this.#email(persoonId), body.antwoord);
    } catch (fout: unknown) {
      if (fout instanceof PasskeyVerificatieFout || fout instanceof PasskeyNietGevondenFout) {
        throw new UnauthorizedException('Passkey geweigerd.');
      }
      throw fout;
    }
    // De passkey moet van de ingelogde persoon zijn. Zonder deze controle zou
    // een geldige passkey van iemand anders de eigen sessie kunnen opwaarderen.
    if (uit.persoonId !== persoonId) throw new UnauthorizedException('Passkey geweigerd.');
    return this.#tokens.markeerMfaGeauthenticeerd(persoonId, refreshToken);
  }

  @Get('passkeys')
  @VereistRecht('auth.mfa.passkey.lees')
  async passkeys(
    @Req() verzoek: MetInlog,
  ): Promise<{ id: bigint; apparaatNaam: string | null; laatstGebruiktOp: Date | null }[]> {
    const persoonId = this.#persoonId(verzoek);
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    return dienst.lijst(persoonId);
  }

  @Delete('passkeys/:id')
  @VereistRecht('auth.mfa.passkey.verwijder')
  async verwijderPasskey(
    @Req() verzoek: MetInlog,
    @Param('id') id: string,
  ): Promise<{ verwijderd: boolean }> {
    const persoonId = this.#persoonId(verzoek);
    let passkeyId: bigint;
    try {
      passkeyId = BigInt(id);
    } catch {
      throw new BadRequestException('Ongeldig passkey-id.');
    }
    const dienst = maakPasskeyService({ db: this.#db, ...rpConfig() });
    return { verwijderd: await dienst.verwijder(persoonId, passkeyId) };
  }
}
