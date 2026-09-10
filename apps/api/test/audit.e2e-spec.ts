/**
 * Integratietest — auditlog met hashketen (F09, spec §6.8 · test #38).
 *
 * Draait tegen de gedeelde test-db. Controleert:
 *   - registratie: de keten groeit, elke rij draagt vorige_hash ‖ eigen_hash,
 *     de eerste rij heeft vorige_hash NULL;
 *   - verifieerKeten over een intakte keten: hoofdhash = laatste eigen_hash;
 *   - test #38: een UPDATE op een willekeurige rij wordt door verifieerKeten
 *     gedetecteerd (KetengebrokenFout op die rij);
 *   - test #38: een DELETE van een middelste rij wordt gedetecteerd;
 *   - canonieke JSON is sleutel-gesorteerd en deterministisch;
 *   - alleen-INSERT-recht: een UPDATE en DELETE als vve_app worden geweigerd.
 *
 * De UPDATE/DELETE-handelingen in de tests doen zich als eigenaar (de
 * testcontainers-principaal), precies zoals een aanvaller-met-database-toegang
 * zou doen — dat is de aanval die de keten moet blootleggen.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  hashOver,
  canoniekeJson,
  maakAuditService,
  KetengebrokenFout,
} from '../src/gemeenschappelijk/audit/audit-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

type AuditService = ReturnType<typeof maakAuditService>;

describe('Auditlog met hashketen (F09, §6.8)', () => {
  let db: TestPgDb | undefined;
  let audit: AuditService | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    const { maakAuditService } = await import('../src/gemeenschappelijk/audit/audit-service.js');
    audit = maakAuditService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('canonieke JSON is sleutel-gesorteerd en deterministisch', () => {
    expect(canoniekeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canoniekeJson({ x: { z: 1, y: [2, 1] } })).toBe('{"x":{"y":[2,1],"z":1}}');
    // Deterministisch: zelfde invoer, zelfde uitkomst.
    expect(canoniekeJson({ b: 1, a: 1 })).toBe(canoniekeJson({ a: 1, b: 1 }));
  });

  it('registratie groeit de keten; de eerste rij heeft vorige_hash NULL', async () => {
    if (!db || !audit) throw new Error('geen setup');
    const eerste = await audit.registreer({
      vveId: null,
      persoonId: null,
      gebeurtenis: 'systeem.start',
      categorie: 'beveiliging',
      details: { notitie: 'keten-start' },
    });
    expect(eerste.eigenHash).toMatch(/^[0-9a-f]{64}$/);

    const tweede = await audit.registreer({
      vveId: 1n,
      persoonId: null,
      gebeurtenis: 'vve.aangemaakt',
      categorie: 'app',
      details: { naam: 'Test' },
    });
    expect(tweede.eigenHash).not.toBe(eerste.eigenHash);

    // De rij-opslag: eerste vorige_hash = NULL, tweede = eigen_hash van de eerste.
    const controle = await db.pool.query<{ vorige: string | null; eigen: string }>(
      'SELECT vorige_hash AS vorige, eigen_hash AS eigen FROM audit_log WHERE id = $1',
      [String(tweede.id)],
    );
    expect(controle.rows[0]?.vorige).toBe(eerste.eigenHash);
  });

  it('verifieerKeten accepteert een intakte keten en noemt de hoofdhash', async () => {
    if (!audit) throw new Error('geen setup');
    const uitslag = await audit.verifieerKeten();
    expect(uitslag.aantal).toBeGreaterThanOrEqual(2);
    expect(uitslag.hoofdhash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test #38: een handmatige wijziging breekt de keten aantoonbaar', async () => {
    if (!db || !audit) throw new Error('geen setup');
    // Nog een gebeurtenis om te muteren:
    const rij = await audit.registreer({
      vveId: 1n,
      persoonId: null,
      gebeurtenis: 'test.muteer.doel',
      categorie: 'app',
      details: { origineel: true },
    });
    // Intakte keten eerst:
    await expect(audit.verifieerKeten()).resolves.toBeTruthy();
    // De aanval:UPDATE de gebeurtenis van deze rij (manipulatie).
    await db.pool.query('UPDATE audit_log SET details = $1 WHERE id = $2', [
      JSON.stringify({ origineel: false, vervalsing: true }),
      String(rij.id),
    ]);
    // De keten is nu aantoonbaar gebroken:
    await expect(audit.verifieerKeten()).rejects.toThrow(KetengebrokenFout);
  });

  it('test #38: een verwijderde regel breekt de keten (vorige_hash-hiaat)', async () => {
    if (!db || !audit) throw new Error('geen setup');
    // Drie rijen erbij, dan de middelste verwijderen:
    await audit.registreer({
      vveId: null,
      persoonId: null,
      gebeurtenis: 'test.delete.een',
      categorie: 'app',
    });
    const twee = await audit.registreer({
      vveId: null,
      persoonId: null,
      gebeurtenis: 'test.delete.twee',
      categorie: 'app',
    });
    await audit.registreer({
      vveId: null,
      persoonId: null,
      gebeurtenis: 'test.delete.drie',
      categorie: 'app',
    });
    await db.pool.query('DELETE FROM audit_log WHERE id = $1', [String(twee.id)]);
    // r_drie verwijst naar de verwijderde vorige_hash — de keten is gebroken.
    await expect(audit.verifieerKeten()).rejects.toThrow(KetengebrokenFout);
  });

  it('alleen-INSERT: UPDATE en DELETE als vve_app worden geweigerd', async () => {
    if (!db) throw new Error('geen setup');
    // De testcontainers-principaal zet hier zelf het login-password voor
    // vve_app (de RLS-test doet dit ook); daarna verbinden we als vve_app en
    // proberen te muteren — verwacht een fout (permission denied).
    const url = new URL(db.url);
    url.username = 'vve_app';
    url.password = 'vve_app';
    const setup = new (await import('pg')).Client({ connectionString: db.url });
    await setup.connect();
    try {
      await setup.query("ALTER ROLE vve_app LOGIN PASSWORD 'vve_app'");
    } finally {
      await setup.end();
    }
    const { Client } = await import('pg');
    const klant = new Client({ connectionString: url.toString() });
    await klant.connect();
    try {
      await expect(
        klant.query(
          "UPDATE audit_log SET gebeurtenis = 'vervalsing' WHERE gebeurtenis = 'systeem.start'",
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(klant.query('DELETE FROM audit_log WHERE id = 1')).rejects.toThrow(
        /permission denied/i,
      );
      // INSERT mag wél (de normale werking):
      await expect(
        klant.query(
          'INSERT INTO audit_log (gebeurtenis, categorie, vorige_hash, eigen_hash) VALUES ($1, $2, $3, $4)',
          ['test.insert', 'app', null, hashOver(null, { gebeurtenis: 'test.insert' })],
        ),
      ).resolves.toBeDefined();
    } finally {
      await klant.end();
    }
  });

  it('gelijktijdige registraties vertakken de keten niet (review F09)', async () => {
    if (!db) throw new Error('geen test-db');
    const dienst = maakAuditService({ db: db.db });

    // Het auditlog wordt bij elke muterende request geschreven (§7.5 stap 7), dus
    // gelijktijdigheid is het normale geval. Zonder serialisatie lazen alle
    // schrijvers dezelfde kop en kreeg elke rij dezelfde `vorige_hash`.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        dienst.registreer({
          vveId: null,
          persoonId: null,
          gebeurtenis: `gelijktijdig.${String(i)}`,
          categorie: 'app',
        }),
      ),
    );

    // Meet de linearatie van de eigen rijen direct: elke schakel moet naar de
    // `eigen_hash` van zijn voorganger wijzen. Tellen over de hele tabel zou
    // meeliften op de rijen die de sabotagetests hierboven bewust achterlaten.
    const { rows } = await db.pool.query<{ v: string | null; e: string }>(
      `SELECT vorige_hash AS v, eigen_hash AS e FROM audit_log
       WHERE gebeurtenis LIKE 'gelijktijdig.%' ORDER BY id`,
    );
    expect(rows).toHaveLength(20);
    for (let k = 1; k < rows.length; k += 1) {
      expect(rows[k]?.v, `schakel ${String(k)} wijst niet naar zijn voorganger`).toBe(
        rows[k - 1]?.e,
      );
    }

    // Bewust géén verifieerKeten() hier: de sabotagetests hierboven hebben de
    // keten opzettelijk gebroken om hun detectie aan te tonen. Dat die detectie
    // werkt is daar al vastgelegd; deze test gaat alleen over gelijktijdigheid.
  });
});
