/**
 * Integratietest — inlogservice (F06c, spec §7.6 · test #29-deel).
 *
 * Draait tegen de gedeelde, gemigreerde test-db. Controleert:
 *   - geslaagde login geeft tokens en reset de pogingenteller;
 *   - onjuist wachtwoord telt de poging op (mislukte_pogingen);
 *   - vijf mislukte pogingen blokkeren het account (geblokkeerd_tot) en
 *     zelfs het juiste wachtwoord faalt dan (fail closed);
 *   - onbekend e-mailadres en verkeerd wachtwoord geven dezelfde melding;
 *   - geslaagde login reset de teller en zet laatste_login_op;
 *   - gedeactiveerde accounts weigeren inloggen;
 *   - de apparatenlijst toont sessies met platform;
 *   - uitloggen zet ingetrokken_op op de sessie-rij.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AccountGeblokkeerdFout,
  MAX_POGINGEN_PER_ACCOUNT,
  maakInlogService,
  OnjuisteInloggegevensFout,
  type InlogService,
} from '../src/gemeenschappelijk/auth/inlog.js';
import { hashWachtwoord } from '../src/gemeenschappelijk/auth/wachtwoord.js';
import { apparaatSessie } from '../src/database/schema/apparaat-sessie.js';
import { maakTokenService } from '../src/gemeenschappelijk/auth/token.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import { persoon } from '../src/database/schema/persoon.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

const GEHEIM = 'x'.repeat(32);
const WACHTWOORD = 'een-voldoende-lang-wachtwoord';

describe('Inlogservice (F06c, §7.6)', () => {
  let db: TestPgDb | undefined;
  let service: InlogService | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    const tokens = maakTokenService({ db: db.db, geheim: GEHEIM, klok: new SystemKlok() });
    service = maakInlogService({ db: db.db, tokens, klok: new SystemKlok() });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seed een persoon met wachtwoordhash; uniek e-mail per test. */
  async function seed(
    volgnummer: number,
    wachtwoord: string,
  ): Promise<{ id: bigint; email: string }> {
    if (!db) throw new Error('geen test-db');
    const { hashWachtwoord } = await import('../src/gemeenschappelijk/auth/wachtwoord.js');
    const email = `inlog${String(volgnummer)}@test.vve`;
    const hash = await hashWachtwoord(wachtwoord);
    const [rij] = await db.db
      .insert(persoon)
      .values({ email, achternaam: `Test${String(volgnummer)}`, wachtwoordHash: hash })
      .returning();
    if (!rij) throw new Error('seed faalde');
    return { id: rij.id, email };
  }

  it('geslaagde login geeft tokens, reset de teller en zet laatste_login_op', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { email } = await seed(1, 'Wachtwoord-één-2026!');
    const uit = await service.inlog(email, 'Wachtwoord-één-2026!', { platform: 'web' });
    expect(uit.persoonId).toBeGreaterThan(0n);
    expect(uit.accessToken).toContain('.');
    expect(uit.refreshToken).toHaveLength(64);

    const controle = await db.pool.query<{ pogingen: number; laatste: Date | null }>(
      'SELECT mislukte_pogingen AS pogingen, laatste_login_op AS laatste FROM persoon WHERE email = $1',
      [email],
    );
    expect(controle.rows[0]?.pogingen).toBe(0);
    expect(controle.rows[0]?.laatste).not.toBeNull();
  });

  it('onjuist wachtwoord telt de poging; onbekend adres geeft dezelfde melding', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { email } = await seed(2, 'Wachtwoord-twee-2026!');

    await expect(
      service.inlog(email, 'verkeerd-wachtwoord-2026!', { platform: 'web' }),
    ).rejects.toThrow(OnjuisteInloggegevensFout);
    await expect(
      service.inlog(email, 'verkeerd-wachtwoord-2026!', { platform: 'web' }),
    ).rejects.toThrow(OnjuisteInloggegevensFout);

    const { rows } = await db.pool.query<{ pogingen: number }>(
      'SELECT mislukte_pogingen AS pogingen FROM persoon WHERE email = $1',
      [email],
    );
    expect(rows[0]?.pogingen).toBe(2);

    // Onbekend e-mailadres: zelfde foutklasse en melding (geen account-teller).
    const onbekend = await service
      .inlog('niemand@test.vve', 'wat-dan-wel-2026!', {})
      .then(() => 'geslaagd')
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(onbekend).toBe('E-mailadres of wachtwoord onjuist');
  });

  it('vijf mislukte pogingen blokkeren; zelfs het juiste wachtwoord faalt dan', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { email } = await seed(3, 'Wachtwoord-drie-2026!');

    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.inlog(email, 'nog-steeds-verkeerd-2026!', { platform: 'web' }),
      ).rejects.toThrow(OnjuisteInloggegevensFout);
    }
    const { rows } = await db.pool.query<{ tot: Date | null; pogingen: number }>(
      'SELECT geblokkeerd_tot AS tot, mislukte_pogingen AS pogingen FROM persoon WHERE email = $1',
      [email],
    );
    const blokkade = rows[0] ?? null;
    if (!blokkade) throw new Error('persoon-rij ontbreekt');
    expect(blokkade.pogingen).toBe(5);
    expect(blokkade.tot).not.toBeNull();

    // Geblokkeerd: óók het juiste wachtwoord wordt geweigerd (fail closed).
    await expect(
      service.inlog(email, 'Wachtwoord-drie-2026!', { platform: 'web' }),
    ).rejects.toThrow(AccountGeblokkeerdFout);
  });

  it('geslaagde login na mislukkingen reset teller en blokkade', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { email } = await seed(4, 'Wachtwoord-vier-2026!');

    await expect(service.inlog(email, 'fout-een-2026!', { platform: 'web' })).rejects.toThrow(
      OnjuisteInloggegevensFout,
    );
    const geslaagd = await service.inlog(email, 'Wachtwoord-vier-2026!', {
      platform: 'web',
    });
    expect(geslaagd.persoonId).toBeGreaterThan(0n);

    const { rows } = await db.pool.query<{ pogingen: number; tot: Date | null }>(
      'SELECT mislukte_pogingen AS pogingen, geblokkeerd_tot AS tot FROM persoon WHERE email = $1',
      [email],
    );
    expect(rows[0]?.pogingen).toBe(0);
    expect(rows[0]?.tot).toBeNull();
  });

  it('gedeactiveerd account weigert inloggen (zelfde melding)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { email } = await seed(5, 'Wachtwoord-vijf-2026!');
    await db.db.update(persoon).set({ actief: false }).where(eq(persoon.email, email));
    await expect(
      service.inlog(email, 'Wachtwoord-vijf-2026!', { platform: 'web' }),
    ).rejects.toThrow(OnjuisteInloggegevensFout);
  });

  it('apparatenlijst toont platform; na uitloggen is de sessie ingetrokken', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { id, email } = await seed(6, 'Wachtwoord-zes-2026!');
    const uit = await service.inlog(email, 'Wachtwoord-zes-2026!', {
      platform: 'web',
      apparaatNaam: 'Testbrowser',
    });

    const lijst = await service.apparaten(id);
    expect(lijst.length).toBeGreaterThanOrEqual(1);
    const deze = lijst.find((r) => r.sessieId === uit.sessieId);
    expect(deze?.platform).toBe('web');

    // Uitloggen via de token-service: de rij blijft (historie), ingetrokken_op komt te staan.
    const tokens = maakTokenService({ db: db.db, geheim: GEHEIM });
    await tokens.trekSessieIn(uit.sessieId);
    const { rows } = await db.pool.query<{ ingetrokken: Date | null; reden: string | null }>(
      'SELECT ingetrokken_op AS ingetrokken, intrekking_reden AS reden FROM apparaat_sessie WHERE id = $1',
      [String(uit.sessieId)],
    );
    expect(rows[0]?.ingetrokken).not.toBeNull();
    expect(rows[0]?.reden).toBe('uitgelogd');
  });
});

describe('Inlog — review F06c', () => {
  let db: TestPgDb | undefined;
  let service: InlogService | undefined;
  let persoonId: bigint;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    const tokens = maakTokenService({ db: db.db, geheim: GEHEIM, klok: new SystemKlok() });
    service = maakInlogService({ db: db.db, tokens, klok: new SystemKlok() });
    const [rij] = await db.db
      .insert(persoon)
      .values({
        email: `review-f06c-${String(Date.now())}@example.test`,
        achternaam: 'Reviewer',
        wachtwoordHash: await hashWachtwoord(WACHTWOORD),
      })
      .returning();
    if (!rij) throw new Error('seed mislukt');
    persoonId = rij.id;
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('een verlopen blokkade begint een nieuw venster in plaats van meteen opnieuw te blokkeren', async () => {
    if (!db) throw new Error('geen test-db');
    const [rij] = await db.db.select().from(persoon).where(eq(persoon.id, persoonId)).limit(1);
    if (!rij) throw new Error('persoon weg');

    // Situatie na een uitgezeten blokkade: teller op het maximum, blokkade verlopen.
    await db.db
      .update(persoon)
      .set({
        misluktePogingen: MAX_POGINGEN_PER_ACCOUNT,
        geblokkeerdTot: new Date(Date.now() - 60_000),
      })
      .where(eq(persoon.id, persoonId));

    // Eén misser mag geen nieuwe blokkade opleveren.
    if (!service) throw new Error('geen service');
    await expect(service.inlog(rij.email, 'fout-wachtwoord', {})).rejects.toBeInstanceOf(
      OnjuisteInloggegevensFout,
    );
    const [na] = await db.db.select().from(persoon).where(eq(persoon.id, persoonId)).limit(1);
    expect(na?.misluktePogingen).toBe(1);
    expect(na?.geblokkeerdTot).toBeNull();

    // En het juiste wachtwoord werkt gewoon weer.
    await expect(service.inlog(rij.email, WACHTWOORD, {})).resolves.toMatchObject({ persoonId });
  });

  it('een onbekend adres kost vergelijkbare tijd als een bestaand adres', async () => {
    if (!db) throw new Error('geen test-db');
    const [rij] = await db.db.select().from(persoon).where(eq(persoon.id, persoonId)).limit(1);
    if (!rij) throw new Error('persoon weg');

    const meet = async (email: string): Promise<number> => {
      const start = process.hrtime.bigint();
      await service?.inlog(email, 'fout-wachtwoord', {}).catch(() => undefined);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    await meet(rij.email); // opwarmen (dummyhash en argon2-cache)
    const bestaand = await meet(rij.email);
    const onbekend = await meet('bestaat-niet-f06c@example.test');

    // Zonder dummyhash keert het onbekende adres bijna direct terug (< 1 ms) terwijl
    // het bestaande tientallen milliseconden argon2 kost. Met dummyhash liggen ze
    // in dezelfde orde van grootte.
    expect(onbekend).toBeGreaterThan(bestaand * 0.3);
  });

  it('apparatenlijst merkt een ingetrokken sessie niet als actief aan', async () => {
    if (!db) throw new Error('geen test-db');
    const [rij] = await db.db.select().from(persoon).where(eq(persoon.id, persoonId)).limit(1);
    if (!rij) throw new Error('persoon weg');

    if (!service) throw new Error('geen service');
    const { sessieId } = await service.inlog(rij.email, WACHTWOORD, { platform: 'web' });
    await db.db
      .update(apparaatSessie)
      .set({ ingetrokkenOp: new Date() })
      .where(eq(apparaatSessie.id, sessieId));

    const lijst = await service.apparaten(persoonId);
    const deze = lijst.find((a) => a.sessieId === sessieId);
    expect(deze?.actief).toBe(false);
  });
});
