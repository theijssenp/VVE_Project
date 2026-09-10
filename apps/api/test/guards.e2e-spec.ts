/**
 * Integratietest — guards, opstarttest en Zod-pipe (F08, §7.5 · tests #30/#32).
 *
 * Draait tegen de gedeelde test-db. Controleert:
 *   - test #32-kern: de route-inventaris bevat élke geregistreerde route mét
 *     recht; een registratie zonder recht is onmogelijk (de registerfunctie
 *     weigert) — deny by default bij opstarten;
 *   - AuthGuard: geen token → 401-klasse; ongeldig token → 401-klasse; een
 *     actieve gebruiker met geldig token → doorgelaten; gedeactiveerde
 *     gebruiker → 401;
 *   - TenantGuard: context zonder vve_id → 403; zonder rol_toewijzing → 403;
 *     mét toewijzing → doorgelaten;
 *   - RolGuard: route zonder declaratie → geweigerd (runtime-achtervang);
 *     geldstroomrecht zonder MFA-herauthenticatie → geweigerd;
 *   - ZodValidationPipe: onbekend veld in de body wordt geweigerd (test #30).
 */

import { eq } from 'drizzle-orm';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Controller, Get } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  maakGuards,
  type AuthGuardsConfig,
  type InlogRequestContext,
} from '../src/gemeenschappelijk/auth/guards.js';
import { VereistRecht } from '../src/gemeenschappelijk/auth/vereist-recht.js';
import {
  controleerRouteDeclaraties,
  inventariseerRoutes,
  routesZonderRecht,
} from '../src/gemeenschappelijk/auth/route-inventaris.js';
import { VEREIST_RECHT_SLEUTEL } from '../src/gemeenschappelijk/auth/vereist-recht.js';
import { tekenAccessToken } from '../src/gemeenschappelijk/auth/token.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import { persoon } from '../src/database/schema/persoon.js';
import { rolToewijzing } from '../src/database/schema/rol-toewijzing.js';
import { vve } from '../src/database/schema/vve.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';
import { parseStrikt } from '../src/gemeenschappelijk/validatie/zod-pipe.js';
import { z } from 'zod';

const GEHEIM = 'x'.repeat(32);

describe('Guards en opstarttest (F08, §7.5)', () => {
  let db: TestPgDb | undefined;
  let config: AuthGuardsConfig | undefined;
  let volg = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    config = { db: db.db, jwtGeheim: GEHEIM, klok: new SystemKlok() };
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seed(): Promise<{ persoonId: bigint; vveId: bigint }> {
    if (!db) throw new Error('geen test-db');
    volg += 1;
    const email = `guard${String(volg)}@test.vve`;
    const [p] = await db.db
      .insert(persoon)
      .values({ email, achternaam: `Guard${String(volg)}` })
      .returning();
    if (!p) throw new Error('seed persoon faalde');
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `GuardVvE${String(volg)}` })
      .returning();
    if (!v) throw new Error('seed vve faalde');
    return { persoonId: p.id, vveId: v.id };
  }

  it('test #32: de echte routes zijn geinventariseerd en allemaal gedeclareerd', async () => {
    const { ALLE_CONTROLLERS } = await import('../src/main.js');
    const routes = inventariseerRoutes(ALLE_CONTROLLERS);

    // Als Nest zijn metadatasleutels ooit hernoemt, vindt de inventaris niets meer
    // en zou de controle stilzwijgend altijd slagen. Daarom eerst: hij vindt echt iets.
    expect(routes.map((r) => `${r.methode} ${r.pad}`)).toContain('GET /health');
    expect(routesZonderRecht(ALLE_CONTROLLERS)).toEqual([]);
    expect(() => {
      controleerRouteDeclaraties(ALLE_CONTROLLERS);
    }).not.toThrow();
  });

  it('test #32: een route zonder @VereistRecht laat de applicatie niet starten', () => {
    // Dit is waar de controle voor bestaat. Een handmatig register zou deze
    // controller nooit zien: hij schrijft zich immers nergens in.
    @Controller('vergeten')
    class VergetenController {
      @Get()
      lijst(): string {
        return 'geen recht gedeclareerd';
      }
    }

    expect(routesZonderRecht([VergetenController])).toHaveLength(1);
    expect(() => {
      controleerRouteDeclaraties([VergetenController]);
    }).toThrow(/zonder @VereistRecht/);
  });

  it('test #32: een klasse-declaratie telt ook, een handler-declaratie wint', () => {
    @Controller('gedekt')
    @VereistRecht('gedekt.lezen')
    class GedektController {
      @Get()
      lijst(): string {
        return 'via de klasse';
      }

      @Get('bijzonder')
      @VereistRecht('gedekt.bijzonder')
      bijzonder(): string {
        return 'via de handler';
      }
    }

    const routes = inventariseerRoutes([GedektController]);
    expect(routes.find((r) => r.pad === '/gedekt')?.recht).toBe('gedekt.lezen');
    expect(routes.find((r) => r.pad === '/gedekt/bijzonder')?.recht).toBe('gedekt.bijzonder');
    expect(routesZonderRecht([GedektController])).toEqual([]);
  });

  it('AuthGuard: geen/ongeldig token → 401; geldig token → doorgelaten', async () => {
    if (!db || !config) throw new Error('geen setup');
    const guards = maakGuards(config);
    const maakContext = (headers: Record<string, unknown>): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      }) as unknown as ExecutionContext;

    // Geen token:
    await expect(guards.authGuard.canActivate(maakContext({}))).rejects.toThrow(
      /Geen geldig access-token/,
    );
    // Ongeldig token:
    await expect(
      guards.authGuard.canActivate(maakContext({ authorization: 'Bearer onzin.token.hier' })),
    ).rejects.toThrow(/ongeldig of verlopen/);

    // Geldig token voor een bestaande, actieve gebruiker:
    const { persoonId } = await seed();
    const token = await tekenAccessToken(persoonId, new SystemKlok(), {
      geheim: GEHEIM,
      minuten: 15,
    });
    await expect(
      guards.authGuard.canActivate(maakContext({ authorization: `Bearer ${token}` })),
    ).resolves.toBe(true);
  });

  it('AuthGuard: gedeactiveerde gebruiker → 401', async () => {
    if (!db || !config) throw new Error('geen setup');
    const guards = maakGuards(config);
    const { persoonId } = await seed();
    await db.db.update(persoon).set({ actief: false }).where(eq(persoon.id, persoonId));
    const token = await tekenAccessToken(persoonId, new SystemKlok(), {
      geheim: GEHEIM,
      minuten: 15,
    });
    const maakContext = (headers: Record<string, unknown>): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      }) as unknown as ExecutionContext;
    await expect(
      guards.authGuard.canActivate(maakContext({ authorization: `Bearer ${token}` })),
    ).rejects.toThrow(/gedeactiveerde gebruiker/);
  });

  it('TenantGuard: zonder vve_id → 403; zonder toewijzing → 403; mét toewijzing → doorgelaten', async () => {
    if (!db || !config) throw new Error('geen setup');
    const guards = maakGuards(config);

    const maakContext = (inlogContext: InlogRequestContext) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ inlogContext }) }),
      }) as unknown as ExecutionContext;

    const { persoonId, vveId } = await seed();

    // Zonder vve_id (geen VvE-keuze in de sessie):
    await expect(
      guards.tenantGuard.canActivate(
        maakContext({ persoonId, vveId: null, mfaGeauthenticeerd: false }),
      ),
    ).rejects.toThrow(/Geen actieve VvE/);

    // Met vve_id maar zonder rol_toewijzing (tweede persoon op de eerste VvE):
    const andere = await seed();
    await expect(
      guards.tenantGuard.canActivate(
        maakContext({
          persoonId: andere.persoonId,
          vveId,
          mfaGeauthenticeerd: false,
        }),
      ),
    ).rejects.toThrow(/Geen actieve rol/);

    // Met toewijzing: doorgelaten.
    await db.db.insert(rolToewijzing).values({
      vveId,
      persoonId: andere.persoonId,
      rol: 'beheerder',
      startDatum: '2026-01-01',
    });
    await expect(
      guards.tenantGuard.canActivate(
        maakContext({ persoonId: andere.persoonId, vveId, mfaGeauthenticeerd: false }),
      ),
    ).resolves.toBe(true);
  });

  it('RolGuard: zonder declaratie geweigerd; geldstroomrecht zonder MFA geweigerd', async () => {
    if (!db || !config) throw new Error('geen setup');
    const guards = maakGuards(config);
    const { persoonId, vveId } = await seed();
    await db.db.insert(rolToewijzing).values({
      vveId,
      persoonId,
      rol: 'beheerder',
      startDatum: '2026-01-01',
    });
    const inlog: InlogRequestContext = {
      persoonId,
      vveId,
      mfaGeauthenticeerd: false,
    };
    const maakContext = (): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ inlogContext: inlog }) }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as unknown as ExecutionContext;

    // De Reflector van de RolGuard-stub: eerst geen metadata, dan het recht.
    const rolGuard = guards.rolGuard as unknown as { reflector: Reflector };
    const origineelGet = rolGuard.reflector.get.bind(rolGuard.reflector);

    rolGuard.reflector.get = (() => undefined) as typeof rolGuard.reflector.get;
    await expect(guards.rolGuard.canActivate(maakContext())).rejects.toThrow(
      /zonder rechtdeclaratie/,
    );

    rolGuard.reflector.get = ((sleutel: string) =>
      sleutel === VEREIST_RECHT_SLEUTEL
        ? { recht: 'incasso.batch.goedkeuren' }
        : undefined) as typeof rolGuard.reflector.get;
    await expect(guards.rolGuard.canActivate(maakContext())).rejects.toThrow(/geldstroom/);

    rolGuard.reflector.get = origineelGet;
  });

  it('ZodValidationPipe: onbekend veld in de body wordt geweigerd (test #30)', () => {
    const schema = z.object({ naam: z.string() }).strict();
    expect(parseStrikt(schema, { naam: 'VvE De Dennen' })).toEqual({ naam: 'VvE De Dennen' });
    // Mass assignment: het extra veld wordt geweigerd.
    expect(() => parseStrikt(schema, { naam: 'X', rol: 'beheerder' })).toThrow(/Ongeldige invoer/);
  });
});
