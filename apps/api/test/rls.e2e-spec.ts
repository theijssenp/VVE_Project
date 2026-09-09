/**
 * Integratietest — RLS-fundament (F04, spec §6.9 · test #33).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (PostgreSQL 16, testcontainers).
 * Controleert, met de applicatiescoping bewust uitgeschakeld (de tests praten
 * rechtstreeks tegen Postgres, niet via de API):
 *
 *   1. Rollen bestaan: vve_migratie, vve_app (geen BYPASSRLS), vve_platform
 *      (wél BYPASSRLS).
 *   2. RLS is ENABLED en FORCED op de tenant-tabel `vve` met policy
 *      tenant_isolatie op app.vve_id.
 *   3. Fail closed: als vve_app query's draait zonder `SET LOCAL app.vve_id`,
 *      levert dat een lege resultset (USING) of een fout (WITH CHECK /
 *      current_setting zonder instelling) op — nooit andermans rijen.
 *   4. Isolatie: verbinding met app.vve_id = A ziet alleen A; schrijven naar
 *      een andere VvE faalt; schrijven binnen de eigen tenant lukt.
 *   5. vve_platform omzeilt RLS (BYPASSRLS) — voor de expliciete beheerendpaths.
 *   6. SET LOCAL lekt niet: na afloop van de transactie is de instelling weg
 *      op dezelfde pool-client (transaction-mode pooling, §6.9).
 *
 * De rollen krijgen een LOGIN-wachtwoord in de test (NOLOGIN-rollen kunnen
 * geen eigen verbinding openen); productie gebruikt dezelfde rollen via een
 * pool die als vve_app verbindt.
 */

import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('RLS-fundament (F04, §6.9)', () => {
  let db: TestPgDb | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Verbindingsclient als een gegeven rol (test-hulp; sluit zelf weer). */
  async function alsRol(rol: string): Promise<{ klant: Client; sluit: () => Promise<void> }> {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const url = new URL(db.url);
    url.username = rol;
    url.password = rol; // test-container: wachtwoord = rolnaam, door de setup hieronder gezet
    const klant = new Client({ connectionString: url.toString() });
    await klant.connect();
    const sluit = async (): Promise<void> => klant.end();
    return { klant, sluit };
  }

  beforeAll(async () => {
    // De rollen zijn NOLOGIN (migratie 0003). Voor de tests geven ze tijdelijk
    // een LOGIN-wachtwoord, gelijk aan hun naam. De superuser-verbinding van de
    // test-container zet dit; in productie gebeurt dit niet.
    if (!db) throw new Error('geen test-db');
    const setup = new Client({ connectionString: db.url });
    await setup.connect();
    try {
      for (const rol of ['vve_migratie', 'vve_app', 'vve_platform']) {
        await setup.query(`ALTER ROLE ${rol} LOGIN PASSWORD '${rol}'`);
      }
      // Bewust GEEN grants hier. LOGIN en wachtwoord moeten wel: die horen als
      // geheim niet in een migratie. De tabelrechten komen uit migratie 0004 —
      // deelt de testopzet ze zelf uit, dan slaagt deze suite ook wanneer de
      // migratie de applicatierol machteloos achterlaat, en dekt het groene
      // vinkje precies het gat dat het zou moeten aantonen.
    } finally {
      await setup.end();
    }
  });

  it('migratie 0003 draaide: drie rollen met de juiste attributen', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { rows } = await db.pool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'vve_%' ORDER BY rolname",
    );
    const opNaam = new Map(rows.map((r) => [r.rolname, r]));
    expect(opNaam.get('vve_migratie')?.rolbypassrls).toBe(false);
    expect(opNaam.get('vve_app')?.rolbypassrls).toBe(false);
    expect(opNaam.get('vve_platform')?.rolbypassrls).toBe(true);
  });

  it('vve heeft RLS ENABLED + FORCED met policy tenant_isolatie', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { rows } = await db.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'vve'",
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);

    const policies = await db.pool.query<{ cmd: string; qual: string | null }>(
      "SELECT cmd, qual FROM pg_policies WHERE tablename = 'vve' AND policyname = 'tenant_isolatie'",
    );
    expect(policies.rowCount).toBeGreaterThan(0);
  });

  it('fail closed: vve_app zonder app.vve_id ziet NIETS uit vve', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    // Seed als superuser (buiten RLS om — de eigenaar, FORCED geldt straks voor
    // de app-rol): twee VvE's.
    const seed = new Client({ connectionString: db.url });
    await seed.connect();
    try {
      await seed.query('INSERT INTO vve (naam) VALUES ($1) ON CONFLICT DO NOTHING', ['RLS A']);
      await seed.query('INSERT INTO vve (naam) VALUES ($1) ON CONFLICT DO NOTHING', ['RLS B']);
    } finally {
      await seed.end();
    }

    const { klant, sluit } = await alsRol('vve_app');
    try {
      // Zonder SET LOCAL: USING-filters op current_setting werpen een fout
      // (fail closed), dus de query faalt — hij toont in elk geval nooit rijen.
      let zetteFoutOfLeeg = false;
      try {
        const r = await klant.query('SELECT id FROM vve');
        zetteFoutOfLeeg = r.rowCount === 0;
      } catch {
        zetteFoutOfLeeg = true; // current_setting zonder waarde werpt — dat is fail closed
      }
      expect(zetteFoutOfLeeg).toBe(true);
    } finally {
      await sluit();
    }
  });

  it('tenant-isolatie: vve_app ziet alleen de eigen VvE en kan niet in een andere schrijven', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    // VvE-id's opzoeken (superuser-verbinding uit db.pool mag RLS omzeilen? Nee:
    // FORCE bindt ook de eigenaar. De pool-principaal is de container-superuser
    // met BYPASSRLS, dus ziet hij alles.)
    const { rows: alle } = await db.pool.query<{ id: string; naam: string }>(
      'SELECT id, naam FROM vve ORDER BY id',
    );
    const a = alle.find((r) => r.naam === 'RLS A');
    const b = alle.find((r) => r.naam === 'RLS B');
    if (!a || !b) throw new Error('seed-rijen RLS A/B ontbreken');

    const { klant, sluit } = await alsRol('vve_app');
    try {
      // Ziet A, niet B:
      await klant.query('BEGIN');
      await klant.query("SELECT set_config('app.vve_id', $1, true)", [a.id]);
      const gezien = await klant.query<{ id: string; naam: string }>('SELECT id, naam FROM vve');
      expect(gezien.rowCount).toBe(1);
      expect(gezien.rows[0]?.naam).toBe('RLS A');
      // Schrijven binnen de eigen tenant lukt (WITH CHECK):
      await klant.query('UPDATE vve SET plaats = $1 WHERE id = $2', ['Amsterdam', a.id]);
      // Schrijven naar B: USING filtert de rij weg, dus UPDATE raakt 0 rijen —
      // dat is de isolatie als lege resultset (§6.9), geen fout.
      const { rowCount: geraakt } = await klant.query('UPDATE vve SET plaats = $1 WHERE id = $2', [
        'X',
        b.id,
      ]);
      expect(geraakt).toBe(0);
      // WITH CHECK blokkeert hard: een INSERT door vve_app maakt een rij met een
      // vers identity-id dat onmogelijk gelijk is aan app.vve_id — row-level
      // security violation.
      await expect(
        klant.query('INSERT INTO vve (naam) VALUES ($1)', ['Frauduleus']),
      ).rejects.toThrow(/row-level security/i);
      await klant.query('COMMIT');
    } finally {
      await sluit();
    }
  });

  it('SET LOCAL verdwijnt na de transactie (geen lek over pool-hergebruik)', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { klant, sluit } = await alsRol('vve_app');
    try {
      await klant.query('BEGIN');
      await klant.query("SELECT set_config('app.vve_id', '1', true)");
      await klant.query('COMMIT');
      // Buiten de transactie is de instelling weg; current_setting met
      // missing_ok = true levert NULL of leeg op, geen vastgezet 1.
      const { rows } = await klant.query<{ v: string | null }>(
        "SELECT current_setting('app.vve_id', true) AS v",
      );
      const v = rows[0]?.v ?? null;
      expect(v === null || v === '').toBe(true);
    } finally {
      await sluit();
    }
  });

  it('vve_platform omzeilt RLS (BYPASSRLS) en ziet beide tenant-rijen', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { klant, sluit } = await alsRol('vve_platform');
    try {
      // Geen SET LOCAL: platform ziet alles.
      const { rowCount } = await klant.query('SELECT id FROM vve');
      expect(rowCount ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      await sluit();
    }
  });

  it('de transactiehelper zet de instelling en leest haar terug', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    const { inTenantTransactie } =
      await import('../src/gemeenschappelijk/tenant/tenant-context.js');
    const { rows: alle } = await db.pool.query<{ id: string; naam: string }>(
      'SELECT id, naam FROM vve ORDER BY id',
    );
    const doel = alle[0];
    if (!doel) throw new Error('geen vve-rij aanwezig');

    const gelezen = await inTenantTransactie(db.db, BigInt(doel.id), async (tx) => {
      const r = await tx.execute<{ instelling: string }>(
        // current_setting zonder tweede arg: faalt hard buiten de context.
        // Binnen de helper is hij per definitie gezet.
        sql`SELECT current_setting('app.vve_id') AS instelling`,
      );
      return { instelling: r.rows[0]?.instelling ?? '' };
    });
    expect(gelezen.instelling).toBe(doel.id);
  });
});
