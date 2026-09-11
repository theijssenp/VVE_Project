/**
 * Integratietest — de HTTP-kant van MFA (F07, spec §7.6 · §8.5).
 *
 * Deze suite bestaat vanwege bevinding B-01 uit het controlelogboek: de
 * servicelaag van F07 was er en was getest, maar er was geen enkel endpoint.
 * De servicetests misten dat, omdat ze de services rechtstreeks aanriepen. Deze
 * test gaat daarom dwars door de echte Nest-keten heen — controller, guard,
 * cookie, token — en niet langs de service.
 *
 * Wat hier bewezen wordt:
 *   - inloggen meldt eerlijk of er een tweede factor nodig is (was een vaste
 *     `false`, waardoor MFA in de praktijk niet bestond);
 *   - TOTP is te activeren en levert secret + herstelcodes één keer op;
 *   - een geldige code levert een access-token mét de `mfa`-claim;
 *   - een verkeerde code levert 401 en géén token;
 *   - een herstelcode werkt één keer en de tweede keer niet meer;
 *   - en het punt waar alles om begonnen was (B-02): de RolGuard laat een
 *     geldstroomrecht dóór op dat token, en weigert het zonder.
 */
import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Controller, Get, UseGuards, type INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DATABASE, DATABASE_POOL } from '../src/database/database.module.js';
import { AuthController } from '../src/modules/auth/auth.controller.js';
import { MfaController } from '../src/modules/auth/mfa.controller.js';
import { SessieGuard } from '../src/modules/auth/sessie.guard.js';
import { RolSessieGuard } from '../src/gemeenschappelijk/auth/tenant-guards.js';
import { persoon } from '../src/database/schema/persoon.js';
import { hashWachtwoord } from '../src/gemeenschappelijk/auth/wachtwoord.js';
import { genereerTotpCodeVoor } from '../src/gemeenschappelijk/auth/totp.js';
import { verifieerAccessToken } from '../src/gemeenschappelijk/auth/token.js';
import { VereistRecht } from '../src/gemeenschappelijk/auth/vereist-recht.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';

/**
 * Een route met een geldstroomrecht — het geval uit bevinding B-02.
 *
 * Dezelfde guardketen als de echte route (`financieel.controller.ts`), op de
 * TenantGuard na: die eist een `vve_id`-claim en een lopende rol, en daar gaat
 * deze test niet over. De RolGuard — die de MFA-poort bewaakt — heeft geen
 * tenantcontext nodig.
 */
@Controller('proef')
@UseGuards(SessieGuard, RolSessieGuard)
class ProefController {
  @Get('afsluiten')
  @VereistRecht('boekjaar.afsluiten')
  afsluiten(): { ok: true } {
    return { ok: true };
  }
}

const WACHTWOORD = 'Proef-MFA-Wachtwoord-42x';
const GEHEIM = 'test-jwt-geheim-minstens-32-tekens-lang!!';

describe('MFA over HTTP (F07, §7.6)', () => {
  let db: TestPgDb;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let http: Server;
  let volg = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    process.env['JWT_SECRET'] = GEHEIM;
    process.env['DATABASE_URL'] = db.url;
    // Geen WEBAUTHN-configuratie: passkeys horen dan netjes te weigeren terwijl
    // TOTP gewoon werkt. Dat pad wordt hieronder ook getoetst.
    delete process.env['WEBAUTHN_RP_ID'];
    delete process.env['WEBAUTHN_ORIGIN'];

    moduleRef = await Test.createTestingModule({
      controllers: [AuthController, MfaController, ProefController],
      providers: [
        SessieGuard,
        RolSessieGuard,
        { provide: DATABASE, useValue: db.db },
        { provide: DATABASE_POOL, useValue: db.pool },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    http = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  /** Verse persoon met wachtwoord; elke test zijn eigen account. */
  async function seedPersoon(): Promise<string> {
    volg += 1;
    const email = `mfa${String(volg)}-${String(process.pid)}@test.vve`;
    await db.db.insert(persoon).values({
      email,
      achternaam: 'Proef',
      wachtwoordHash: await hashWachtwoord(WACHTWOORD),
      actief: true,
    });
    return email;
  }

  /** Logt in en geeft het access-token, de cookie en de mfaVereist-vlag terug. */
  async function login(email: string): Promise<{
    accessToken: string;
    cookie: string[];
    mfaVereist: boolean;
  }> {
    const res = await request(http)
      .post('/auth/inloggen')
      .send({ email, wachtwoord: WACHTWOORD, client: 'web' });
    expect(res.status).toBe(201);
    const body = res.body as { accessToken: string; mfaVereist: boolean };
    return {
      accessToken: body.accessToken,
      cookie: res.headers['set-cookie'] as unknown as string[],
      mfaVereist: body.mfaVereist,
    };
  }

  it('zonder tweede factor meldt inloggen mfaVereist: false', async () => {
    const email = await seedPersoon();
    const uit = await login(email);
    expect(uit.mfaVereist).toBe(false);
  });

  it('activeert TOTP en geeft secret én herstelcodes één keer terug', async () => {
    const email = await seedPersoon();
    const { accessToken } = await login(email);

    const res = await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(res.status).toBe(201);
    const body = res.body as { secret: string; otpauth: string; herstelcodes: string[] };
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.otpauth).toContain('otpauth://totp/');
    expect(body.herstelcodes).toHaveLength(10);

    // Het secret staat versleuteld in de database, niet in platte tekst.
    const [rij] = await db.db
      .select({ geheim: persoon.totpSecretVersleuteld })
      .from(persoon)
      .where(eq(persoon.email, email))
      .limit(1);
    expect(rij?.geheim).not.toBeNull();
    expect(rij?.geheim?.toString('utf8')).not.toContain(body.secret);
  });

  it('na activatie meldt inloggen mfaVereist: true', async () => {
    const email = await seedPersoon();
    const eerste = await login(email);
    expect(eerste.mfaVereist).toBe(false);

    await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${eerste.accessToken}`)
      .send({});

    const tweede = await login(email);
    expect(tweede.mfaVereist).toBe(true);
  });

  it('een geldige code levert een token mét de mfa-claim; een verkeerde levert 401', async () => {
    const email = await seedPersoon();
    const { accessToken, cookie } = await login(email);
    const activatie = await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    const { secret } = activatie.body as { secret: string };

    const fout = await request(http)
      .post('/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ code: '000000' });
    expect(fout.status).toBe(401);
    expect(fout.body).not.toHaveProperty('accessToken');

    const goed = await request(http)
      .post('/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ code: await genereerTotpCodeVoor(secret) });
    expect(goed.status).toBe(201);

    const nieuw = (goed.body as { accessToken: string }).accessToken;
    const ontleed = await verifieerAccessToken(nieuw, new SystemKlok(), { geheim: GEHEIM });
    expect(ontleed.mfaGeauthenticeerd).toBe(true);

    // En het token van vóór de step-up draagt de claim niet.
    const oud = await verifieerAccessToken(accessToken, new SystemKlok(), { geheim: GEHEIM });
    expect(oud.mfaGeauthenticeerd).toBe(false);
  });

  it('een herstelcode werkt één keer en daarna niet meer (§6.3)', async () => {
    const email = await seedPersoon();
    const { accessToken, cookie } = await login(email);
    const activatie = await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    const { herstelcodes } = activatie.body as { herstelcodes: string[] };
    const code = herstelcodes[0];
    if (code === undefined) throw new Error('geen herstelcode');

    const eerste = await request(http)
      .post('/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ herstelcode: code });
    expect(eerste.status).toBe(201);

    const tweede = await request(http)
      .post('/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ herstelcode: code });
    expect(tweede.status).toBe(401);
  });

  it('B-02: het geldstroomrecht gaat dicht zonder tweede factor en open met', async () => {
    const email = await seedPersoon();
    const { accessToken, cookie } = await login(email);

    // Zonder enige tweede factor: de RolGuard weigert het geldstroomrecht.
    // Dít was de vastloper — er was geen enkele manier om hier voorbij te komen.
    const dicht = await request(http)
      .get('/proef/afsluiten')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(dicht.status).toBe(403);

    const activatie = await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    const { secret } = activatie.body as { secret: string };
    const stapUp = await request(http)
      .post('/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .send({ code: await genereerTotpCodeVoor(secret) });
    const mfaToken = (stapUp.body as { accessToken: string }).accessToken;

    const open = await request(http)
      .get('/proef/afsluiten')
      .set('Authorization', `Bearer ${mfaToken}`);
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ ok: true });
  });

  it('let op: de poort toetst bezit van een factor, nog geen herauthenticatie', async () => {
    // Vastgelegd omdat het makkelijk verkeerd te lezen is. `RolGuard` slaat de
    // databasecontrole over als het token de mfa-claim draagt, en controleert
    // anders of de persoon een factor *heeft*. Wie TOTP heeft geactiveerd komt
    // er dus ook met een token van vóór de step-up langs. Dat is wat F07
    // oplevert; herauthenticatie per handeling stond in de code van F07
    // aangekondigd voor F08 en is daar niet gebouwd (zie bevinding B-10).
    const email = await seedPersoon();
    const { accessToken } = await login(email);
    await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    const zonderClaim = await request(http)
      .get('/proef/afsluiten')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(zonderClaim.status).toBe(200);
  });

  it('de statusroute vertelt welke factoren er zijn', async () => {
    const email = await seedPersoon();
    const { accessToken } = await login(email);

    const voor = await request(http).get('/auth/mfa').set('Authorization', `Bearer ${accessToken}`);
    expect(voor.body).toEqual({ actief: false, totp: false, passkeys: 0 });

    await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    const na = await request(http).get('/auth/mfa').set('Authorization', `Bearer ${accessToken}`);
    expect(na.body).toEqual({ actief: true, totp: true, passkeys: 0 });
  });

  it('zonder WebAuthn-configuratie weigeren de passkey-routes, TOTP blijft werken', async () => {
    const email = await seedPersoon();
    const { accessToken } = await login(email);

    const res = await request(http)
      .post('/auth/mfa/passkey/registratie-opties')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('WEBAUTHN_RP_ID');

    const totp = await request(http)
      .post('/auth/mfa/totp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(totp.status).toBe(201);
  });

  it('zonder sessie is geen enkele MFA-route bereikbaar', async () => {
    const zonder = await request(http).get('/auth/mfa');
    expect(zonder.status).toBe(401);
    const stapUp = await request(http).post('/auth/mfa').send({ code: '123456' });
    expect(stapUp.status).toBe(401);
  });
});
