/**
 * Integratietest — token-uitgifte en apparaat-sessies (F06b, spec §7.6).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (PostgreSQL 16, testcontainers —
 * migraties 0001–0005, dus `apparaat_sessie` én `rol_toewijzing` bestaan).
 * Controleert, met de echte `token`-service maar één **nepklok** (zodat
 * expiratie niet aan wall-clock wordt gekoppeld — spec F06a: "geen
 * timing-asserts"):
 *
 *     1. JWT is verifieerbaar met de juiste claims (sub/iss/aud).
 *     2. Het ruwe refresh-token verlaat de db niet (alleen sha256-hex, §8.2).
 *     3. Een access-token verloopt na 15 min (exp-claim), via de klok.
 *     4. Rotatie: de oude token wordt na inwisseling geweigerd, de nieuwe werkt.
 *     5. **Hergebruikdetectie** (kern test #35): een reeds ingewisseld token
 *       trekt de HELE `familie_id` in — alle rijen worden ingetrokken.
 *     6. `trekSessieIn` / `trekAlleSessiesIn` intake de juiste rijen.
 *     7. Onbekende en verlopen tokens worden met een specifieke fout geweigerd.
 *
 * Elke test seedt haar eigen `persoon` (FK-target) met een unieke e-mail, zodat
 * de tests onafhankelijk zijn van de uitvoer-ordening.
 */

import { JOSEError } from 'jose/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Klok } from '../src/gemeenschappelijk/system-klok.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';
import { persoon } from '../src/database/schema/index.js';
import {
  HergebruikGesignaleerdFout,
  maakTokenService,
  OnbekendTokenFout,
  verifieerAccessToken,
  VerlopenTokenFout,
} from '../src/gemeenschappelijk/auth/token.js';

// ---------------------------------------------------------------------------
// Hulp
// ---------------------------------------------------------------------------

/**
 * Controleerbare `Klok`: de tijd zit in één verstelbare basis-tijd, zodat een
 * test een token kan laten verlopen door de klok vooruit te springen —
 * deterministisch, zonder te `sleep`en (spec F06a: "geen timing-asserts").
 */
function verstelbareKlok(basisMs: number): { klok: Klok; spring: (ms: number) => void } {
  let t = basisMs;
  const nu = (): Date => new Date(t);
  const klok: Klok = {
    nu,
    vandaag: () => {
      const deeltjes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(nu());
      const [jaar, maand, dag] = deeltjes
        .map((d) => d.value)
        .join('/')
        .split('/');
      return { jaar: Number(jaar), maand: Number(maand), dag: Number(dag) };
    },
  };
  return { klok, spring: (ms: number) => (t += ms) };
}

let emailAantal = 0;
const GEHEIM = 'test-geheim-voldoende-lange-secret-waarde'; // ≥ 16 tekens

/** Seedt een `persoon` en levert haar id terug (FK-target voor `apparaat_sessie`). */
async function seedPersoon(db: TestPgDb): Promise<bigint> {
  emailAantal += 1;
  const nodePid = process.env['NODE_PID'] ?? '0';
  const [rij] = await db.db
    .insert(persoon)
    .values({
      email: `token-${String(emailAantal)}-${nodePid}@voorbeeld.nl`,
      achternaam: 'Tokeentest',
    })
    .returning({ id: persoon.id });
  if (!rij) throw new Error('persoon-seed leverde geen rij op');
  return rij.id;
}

async function actieveRijentelling(db: TestPgDb, persoonId: bigint): Promise<number> {
  const { rows } = await db.pool.query<{ actief: string }>(
    'SELECT count(*) FILTER (WHERE ingetrokken_op IS NULL)::int AS actief ' +
      'FROM apparaat_sessie WHERE persoon_id = $1',
    [String(persoonId)],
  );
  return Number(rows[0]?.actief ?? 0);
}

async function totaleRijentelling(db: TestPgDb, persoonId: bigint): Promise<number> {
  const { rows } = await db.pool.query<{ totaal: number }>(
    'SELECT count(*)::int AS totaal FROM apparaat_sessie WHERE persoon_id = $1',
    [String(persoonId)],
  );
  return rows[0]?.totaal ?? 0;
}

describe('Token-uitgifte & apparaat-sessies (F06b, §7.6)', () => {
  let db: TestPgDb | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('geeft een verifieerbaar JWT uit met de juiste claims (sub/iss/aud)', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM });

    const { accessToken, refreshToken, sessieId } = await service.geefTokensUit(
      { id: persoonId },
      { platform: 'web' },
    );

    const claims = await verifieerAccessToken(accessToken, klok, { geheim: GEHEIM });
    expect(claims.sub).toBe(String(persoonId));
    expect(claims.iss).toBe('vve-api');
    expect(claims.aud).toBe('vve');
    expect(refreshToken).toMatch(/^[0-9a-f]{64}$/); // 32 bytes CSPRNG → hex
    expect(typeof sessieId).toBe('bigint');
  });

  it('verlaat het ruwe refresh-token niet in de db (alleen sha256-hex)', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM });
    const { refreshToken } = await service.geefTokensUit({ id: persoonId }, {});

    const result = await db.pool.query<{ refresh_token_hash: string }>(
      'SELECT refresh_token_hash FROM apparaat_sessie WHERE persoon_id = $1',
      [String(persoonId)],
    );
    const rij = result.rows[0];
    expect(rij).toBeDefined();
    expect(rij?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // De hash is óók níet het ruwe token (anders staat het ruwe token in de db).
    expect(rij?.refresh_token_hash).not.toBe(refreshToken);
    expect(rij?.refresh_token_hash.toLowerCase()).not.toContain(refreshToken.slice(0, 12));
  });

  it('een access-token verloopt na 15 minuten (exp-claim), via de klok', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok, spring } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM }); // default 15 min

    const { accessToken } = await service.geefTokensUit({ id: persoonId }, {});
    // Geldig op het uitdeelmoment.
    expect(await verifieerAccessToken(accessToken, klok, { geheim: GEHEIM })).toBeDefined();
    // Spring net over de 15-minuut-grens; nu faalt de verifiëring.
    spring(15 * 60 * 1000 + 1000);
    await expect(verifieerAccessToken(accessToken, klok, { geheim: GEHEIM })).rejects.toThrow(
      JOSEError,
    );
  });

  it('verifieert niet tegen een ander geheim', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM });
    const { accessToken } = await service.geefTokensUit({ id: persoonId }, {});

    await expect(
      verifieerAccessToken(accessToken, klok, {
        geheim: 'een-andere-voldoende-lange-secret-waarde',
      }),
    ).rejects.toThrow();
  });

  it('rotereert: de oude token wordt geweigerd, de nieuwe werkt', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM, refreshDagen: 30 });

    const { refreshToken: r0, accessToken } = await service.geefTokensUit({ id: persoonId }, {});
    expect((await verifieerAccessToken(accessToken, klok, { geheim: GEHEIM })).sub).toBe(
      String(persoonId),
    );

    // r0 (actieve rij) roteert naar r1, in dezelfde `familie_id`.
    const r1 = await service.verfris(r0, { ip: '127.0.0.1' });
    expect(r1.refreshToken).not.toBe(r0);
    expect(r1.persoonId).toBe(persoonId);

    // De nieuwe token werkt (r1 → r2).
    const r2 = await service.verfris(r1.refreshToken, {});
    expect(r2.refreshToken).not.toBe(r1.refreshToken);

    // De ouderwetse r0 is nu geconsumeerd → hergebruik → geweigerd.
    await expect(service.verfris(r0, {})).rejects.toThrow(HergebruikGesignaleerdFout);
  });

  it('herbruikdetectie: een reeds ingewisseld token trekt de HELE familie in', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM, refreshDagen: 30 });

    // Eén apparaat, één rotatie → twee rijen dezelfde familie:
    // R0 (wordt bij de rotatie ingetrokken 'geroteerd'), R1 (actief).
    const { refreshToken: r0 } = await service.geefTokensUit(
      { id: persoonId },
      { platform: 'ios' },
    );
    const r1 = await service.verfris(r0, {});
    expect(await totaleRijentelling(db, persoonId)).toBe(2);
    expect(await actieveRijentelling(db, persoonId)).toBe(1);

    // Herbruik: r0 aanbieden nádat het reeds is ingewisseld.
    await expect(service.verfris(r0, {})).rejects.toThrow(HergebruikGesignaleerdFout);

    // De HELE familie is nu ingetrokken: 0 actieve rijen (ook r1).
    expect(await actieveRijentelling(db, persoonId)).toBe(0);
    expect(await totaleRijentelling(db, persoonId)).toBe(2);

    // Zelfs de "nieuwe" r1 is nu onbruikbaar: de familie is ingetrokken, en r1
    // is zelf een geconsumeerd refresh_token_hash → herbruik-branch opnieuw.
    await expect(service.verfris(r1.refreshToken, {})).rejects.toThrow(HergebruikGesignaleerdFout);
  });

  it('trekSessieIn: uitloggen trekt de eigen sessie in', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM, refreshDagen: 30 });

    const { sessieId } = await service.geefTokensUit({ id: persoonId }, {});
    expect((await service.trekSessieIn(sessieId)).ingetrokken).toBe(true);

    // Dubbel uitlezen doet niets (reeds ingetrokken).
    expect((await service.trekSessieIn(sessieId)).ingetrokken).toBe(false);

    // De rij heeft reden 'uitgelogd' en een `ingetrokken_op`.
    const { rows } = await db.pool.query<{ reden: string | null; ts: string | null }>(
      'SELECT intrekking_reden AS reden, ingetrokken_op AS ts FROM apparaat_sessie WHERE id = $1',
      [String(sessieId)],
    );
    expect(rows[0]?.reden).toBe('uitgelogd');
    expect(rows[0]?.ts).not.toBeNull();
  });

  it('trekAlleSessiesIn: "log alle apparaten uit" trekt alle rijen van de persoon in', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM, refreshDagen: 30 });

    // Drie apparaten (drie families) voor dezelfde persoon.
    const a = await service.geefTokensUit({ id: persoonId }, { platform: 'web' });
    const b = await service.geefTokensUit({ id: persoonId }, { platform: 'ios' });
    const c = await service.geefTokensUit({ id: persoonId }, { platform: 'android' });
    expect(await actieveRijentelling(db, persoonId)).toBe(3);

    expect((await service.trekAlleSessiesIn(persoonId)).ingetrokken).toBe(3);
    expect(await actieveRijentelling(db, persoonId)).toBe(0);

    // En geen van de drie werkt meer (geen actieve rij met die hash).
    await expect(service.verfris(a.refreshToken, {})).rejects.toThrow(HergebruikGesignaleerdFout);
    await expect(service.verfris(b.refreshToken, {})).rejects.toThrow(HergebruikGesignaleerdFout);
    await expect(service.verfris(c.refreshToken, {})).rejects.toThrow(HergebruikGesignaleerdFout);
  });

  it('weigert een onbekende refresh-token met een specifieke fout', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { klok } = verstelbareKlok(Date.now());
    const service = maakTokenService({
      db: db.db,
      klok,
      geheim: GEHEIM,
      refreshDagen: 30,
    });
    await expect(service.verfris('d00d-d00d-geen-echt-token', {})).rejects.toThrow(
      OnbekendTokenFout,
    );
  });

  it('weigert een verlopen refresh-token met een specifieke fout', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const persoonId = await seedPersoon(db);
    const { klok, spring } = verstelbareKlok(Date.now());
    const service = maakTokenService({ db: db.db, klok, geheim: GEHEIM, refreshDagen: 1 });

    const { refreshToken } = await service.geefTokensUit({ id: persoonId }, {});
    // Spring voorbij de refresh-levensduur (1 dag).
    spring(2 * 24 * 60 * 60 * 1000);
    await expect(service.verfris(refreshToken, {})).rejects.toThrow(VerlopenTokenFout);
  });
});

describe('TokenService — geheim is verplicht (F06b-review)', () => {
  let db: TestPgDb | undefined;
  const oorspronkelijk = process.env['JWT_SECRET'];

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });
  afterAll(async () => {
    await db?.stop();
    if (oorspronkelijk === undefined) delete process.env['JWT_SECRET'];
    else process.env['JWT_SECRET'] = oorspronkelijk;
  });

  it('start niet zonder JWT_SECRET: er is bewust geen standaardwaarde', () => {
     const testDb = db;
    if (!testDb) throw new Error('geen test-db');
    delete process.env['JWT_SECRET'];
    expect(() =>
      maakTokenService({ db: testDb.db, klok: verstelbareKlok(1_700_000_000_000).klok }),
     ).toThrow(/JWT_SECRET ontbreekt/);
    });

   it('weigert een te kort geheim', () => {
      const testDb = db;
     if (!testDb) throw new Error('geen test-db');
     delete process.env['JWT_SECRET'];
     expect(() =>
       maakTokenService({
         db: testDb.db,
         klok: verstelbareKlok(1_700_000_000_000).klok,
         geheim: 'te-kort',
        }),
      ).toThrow(/minimaal 32 tekens/);
     });

   it('accepteert een geheim uit de omgeving', () => {
     const testDb = db;
     if (!testDb) throw new Error('geen test-db');
     process.env['JWT_SECRET'] = 'x'.repeat(48);
     expect(() =>
       maakTokenService({ db: testDb.db, klok: verstelbareKlok(1_700_000_000_000).klok }),
       ).not.toThrow();
    });
});
