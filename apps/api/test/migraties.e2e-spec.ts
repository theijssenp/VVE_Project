/**
 * Integratietest — migratierunner (F03, DoD).
 *
 * Tegen een echte PostgreSQL-16 container (zelfde image/digest als
 * `infra/docker-compose.yml`). Twee aspecten:
 *   1. Migraties draaien **in volgorde** en **alleen voorwaarts** — 0001 vóór
 *      0002; 0002 veronderstelt dat 0001 de extensies/enums heeft aangemaakt.
 *   2. **Idempotentie**: twee opeenvolgende runs voegen niets toe — de tweede
 *      draai slaat beide over omdat ze al in `migratie_historie` staan.
 *   3. **Alleen voorwaarts**: een reeds toegepaste migratie die later wordt
 *      bewerkt, wordt via de checksum herkend en afgewezen.
 */

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gedeeldeTestDb, legeDatabaseUrl, type TestPgDb } from './testcontainers.js';
import { voerMigratiesUit } from '../src/database/run-migraties.js';

describe('Migratierunner (F03)', () => {
  let db: TestPgDb | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('migraties zijn in volgorde uitgevoerd: 0001 vóór 0002', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    // Sorteren op `opgevoerd_op`, niet op naam: op naam sorteren maakt de test
    // tautologisch — die bewijst alleen dat '0001' < '0002' alfabetisch is, niet
    // dat 0001 daadwerkelijk eerder is uitgevoerd.
    const { rows } = await db.pool.query<{ naam: string }>(
      'SELECT naam FROM migratie_historie ORDER BY opgevoerd_op, naam',
    );
    const namen = rows.map((r) => r.naam);

    expect(namen).toEqual(['0001_extensies_enums', '0002_vve_persoon']);
  });

  it('weigert te draaien als een reeds toegepaste migratie is gewijzigd', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const url = await legeDatabaseUrl(db, 'checksum_test');
    await voerMigratiesUit(url);

    // Simuleer een bewerkte migratie door de opgeslagen checksum te vervalsen.
    const klant = new Client({ connectionString: url });
    await klant.connect();
    try {
      await klant.query("UPDATE migratie_historie SET checksum = 'afwijkend' WHERE naam = $1", [
        '0001_extensies_enums',
      ]);
    } finally {
      await klant.end();
    }

    await expect(voerMigratiesUit(url)).rejects.toThrow(/gewijzigd nadat hij was toegepast/);
  });

  it('legt van elke uitgevoerde migratie een checksum vast', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const { rows } = await db.pool.query<{ naam: string; checksum: string | null }>(
      'SELECT naam, checksum FROM migratie_historie ORDER BY naam',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const rij of rows) {
      expect(rij.checksum, `checksum ontbreekt voor ${rij.naam}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('tweemaal db:migrate voegt niets toe (idempotent)', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const url = await legeDatabaseUrl(db, 'idempotentie_test');
    const eerste = await voerMigratiesUit(url);
    const tweede = await voerMigratiesUit(url);

    expect(eerste.uitgevoerde).toEqual(['0001_extensies_enums', '0002_vve_persoon']);
    expect(tweede.uitgevoerde).toEqual([]);
    expect(tweede.bestaand).toEqual(['0001_extensies_enums', '0002_vve_persoon']);
  });
});
