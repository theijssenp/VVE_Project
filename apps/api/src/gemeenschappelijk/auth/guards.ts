/**
 * AuthGuard + TenantGuard + RolGuard — F08 (spec §7.5 stap 1–3, tests #27/#32).
 *
 * Volgorde per request (§7.5):
 *   1. AuthGuard    — verifieert het access-token (HS256, iss/aud/exp via
 *                     `verifieerAccessToken` uit F06b) en laadt de persoon.
 *                     Geen/ongeldig token → 401.
 *   2. TenantGuard  — bepaalt de actieve VvE uit het token-claim `vve_id`,
 *                     controleert een actieve rol_toewijzing. De client kiest
 *                     niets; een tenant die het token niet draagt wordt
 *                     geweigerd (403).
 *   3. RolGuard     — leest `@VereistRecht` (deny by default, test #32) en
 *                     toetst het recht; geldstroomrechten vereisen MFA (F07).
 *
 * De guards zijn een slanke Nest-adapterlaag: de inhoudelijke logica staat in
 * de services (auth/, tenant/); de guards vertalen fouten naar HTTP-status
 * (401/403; 404-beslissingen blijven in de services, §7.5 stap 6).
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { persoon } from '../../database/schema/persoon.js';
import { rolToewijzing } from '../../database/schema/rol-toewijzing.js';
import { VEREIST_RECHT_SLEUTEL } from './vereist-recht.js';
import { MfaVereistFout, maakMfaGate, type MfaGate } from './mfa-gate.js';
import { verifieerAccessToken, type DecodedAccessToken } from './token.js';
import type { Klok } from '../system-klok.js';

// ---------------------------------------------------------------------------
// Fouten met HTTP-status-advies
// ---------------------------------------------------------------------------

export class GuardFout extends Error {
  constructor(
    readonly status: 401 | 403,
    melding: string,
  ) {
    super(melding);
    this.name = 'GuardFout';
  }
}

/** Vertaalt een GuardFout naar een Nest-exception voor de HTTP-laag. */
export function alsNestFout(fout: GuardFout): UnauthorizedException | ForbiddenException {
  return fout.status === 401
    ? new UnauthorizedException(fout.message)
    : new ForbiddenException(fout.message);
}

// ---------------------------------------------------------------------------
// Inlog-context (tussen de guards doorgegeven op het verzoek)
// ---------------------------------------------------------------------------

export interface InlogRequestContext {
  readonly persoonId: bigint;
  readonly vveId: bigint | null;
  /** Heeft de gebruiker op dit verzoek opnieuw MFA geleverd? (§7.6 herauthenticatie.) */
  readonly mfaGeauthenticeerd: boolean;
}

interface NestVerzoek {
  readonly headers: Record<string, unknown>;
  inlogContext?: InlogRequestContext;
}

function leesBearer(headers: Record<string, unknown>): string | null {
  const ruw = headers['authorization'];
  if (typeof ruw !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(ruw.trim());
  return match?.[1] ?? null;
}

export interface AuthGuardsConfig {
  readonly db: NodePgDatabase;
  /** JWT-geheim (spec §8.2: geen standaardwaarde, zie F06b-besluit). */
  readonly jwtGeheim: string;
  /** Tijdsbron voor de exp-toets (SystemKlok in productie, nepklok in tests). */
  readonly klok: Klok;
}

// ---------------------------------------------------------------------------
// AuthGuard — stap 1
// ---------------------------------------------------------------------------

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: AuthGuardsConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const verzoek = context.switchToHttp().getRequest<NestVerzoek>();
    const token = leesBearer(verzoek.headers);
    if (token === null) {
      throw alsNestFout(new GuardFout(401, 'Geen geldig access-token'));
    }
    let gecodeerd: DecodedAccessToken;
    try {
      gecodeerd = await verifieerAccessToken(token, this.config.klok, {
        geheim: this.config.jwtGeheim,
      });
    } catch {
      throw alsNestFout(new GuardFout(401, 'Access-token ongeldig of verlopen'));
    }
    // De persoon moet nog actief zijn (§3.3: deactiveren bij eigenaarswissel).
    const [rij] = await this.config.db
      .select({ id: persoon.id, actief: persoon.actief })
      .from(persoon)
      .where(eq(persoon.id, gecodeerd.persoonId))
      .limit(1);
    if (rij === undefined || !rij.actief) {
      throw alsNestFout(new GuardFout(401, 'Onbekende of gedeactiveerde gebruiker'));
    }
    verzoek.inlogContext = {
      persoonId: gecodeerd.persoonId,
      vveId: gecodeerd.vveId,
      mfaGeauthenticeerd: gecodeerd.mfaGeauthenticeerd,
    };
    return true;
  }
}

// ---------------------------------------------------------------------------
// TenantGuard — stap 2
// ---------------------------------------------------------------------------

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly config: AuthGuardsConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const verzoek = context.switchToHttp().getRequest<NestVerzoek>();
    const inlog = verzoek.inlogContext;
    if (inlog === undefined) {
      throw alsNestFout(new GuardFout(401, 'Auth ontbreekt op deze route'));
    }
    // De tenant komt uit het token; de client kiest niets (§7.5 stap 2).
    if (inlog.vveId === null) {
      throw alsNestFout(new GuardFout(403, 'Geen actieve VvE in de sessie'));
    }
    // Er moet een rol_toewijzing in die VvE zijn (actief of nog lopend).
    const toewijzingen = await this.config.db
      .select({ id: rolToewijzing.id })
      .from(rolToewijzing)
      .where(
        and(eq(rolToewijzing.vveId, inlog.vveId), eq(rolToewijzing.persoonId, inlog.persoonId)),
      )
      .limit(1);
    if (toewijzingen.length === 0) {
      throw alsNestFout(new GuardFout(403, 'Geen actieve rol in deze VvE'));
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// RolGuard — stap 3 (deny by default, test #32)
// ---------------------------------------------------------------------------

@Injectable()
export class RolGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(
    private readonly config: AuthGuardsConfig,
    private readonly mfaGate: MfaGate,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const klasse = context.getClass();
    const metadata =
      this.reflector.get<{ readonly recht: string } | undefined>(VEREIST_RECHT_SLEUTEL, handler) ??
      this.reflector.get<{ readonly recht: string } | undefined>(VEREIST_RECHT_SLEUTEL, klasse);
    if (metadata === undefined || typeof metadata.recht !== 'string') {
      // Deny by default (§7.5): een route zonder declaratie weigert. Test #32
      // vangt de ontbrekende declaratie al bij het opstarten; dit is de
      // runtime-achtervang.
      throw alsNestFout(new GuardFout(403, 'Route zonder rechtdeclaratie is geweigerd'));
    }
    const verzoek = context.switchToHttp().getRequest<NestVerzoek>();
    const inlog = verzoek.inlogContext;
    if (inlog === undefined) {
      throw alsNestFout(new GuardFout(401, 'Auth ontbreekt op deze route'));
    }
    // Geldstroomrechten vereisen MFA (§7.6/§8.5, F07-gate).
    if (this.mfaGate.isGeldstroomRecht(metadata.recht) && !inlog.mfaGeauthenticeerd) {
      try {
        await this.mfaGate.vereisMfaVoor(inlog.persoonId, metadata.recht);
      } catch (fout: unknown) {
        // `MfaVereistFout` is een weigering, geen storing. Zonder deze vertaling
        // viel hij als onbekende fout door de filter heen en kreeg de gebruiker
        // een 500 met een referentienummer — een geldstroomhandeling die eruitziet
        // alsof de server stuk is in plaats van "u mist een tweede factor".
        // De bestaande guardtest zag dit niet: die roept de guard rechtstreeks
        // aan en toetst alleen dát hij werpt.
        if (fout instanceof MfaVereistFout) {
          throw alsNestFout(new GuardFout(403, fout.message));
        }
        throw fout;
      }
    }
    return true;
  }
}

/** Bouwt de MFA-gate voor de RolGuard (DI-vriendelijke fabriek). */
export function maakGuards(config: AuthGuardsConfig): {
  authGuard: AuthGuard;
  tenantGuard: TenantGuard;
  rolGuard: RolGuard;
} {
  const mfaGate = maakMfaGate({ db: config.db });
  return {
    authGuard: new AuthGuard(config),
    tenantGuard: new TenantGuard(config),
    rolGuard: new RolGuard(config, mfaGate),
  };
}
