/**
 * Integratietest — migratierunner (F03, DoD).
 *
 * Tegen een echte PostgreSQL-16 container (zelfde image/digest als
 * `infra/docker-compose.yml`). Twee aspecten:
 *   1. Migraties draaien **in volgorde** en **alleen voorwaarts** — 0001 vóór
 *      0002; 0002 veronderstelt dat 0001 de extensies/enums heeft aangemaakt.
 *   2. **Idempotentie**: twee opeenvolgende dringen voegen niets toe — de
 *      tweede draai slaat beide over omdat ze al in `migratie_historie` staan.
 */

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

  it('migraties draaien in volgorde: 0001 vóór 0002', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const { rows } = await db.pool.query<{ naam: string }>(
      'SELECT naam FROM migratie_historie ORDER BY naam',
    );
    const namen = rows.map((r) => r.naam);

    expect(namen).toContain('0001_extensies_enums');
    expect(namen).toContain('0002_vve_persoon');
    expect(namen.indexOf('0001_extensies_enums')).toBeLessThan(namen.indexOf('0002_vve_persoon'));
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
