/**
 * Integratietest — schema `vve`/`persoon` en data-integriteit (F03, spec §6.3).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (PostgreSQL 16). Controleert:
 *     - defaults op `vve` (breukdeel_noemer 1000, boekjaar_startmaand 1,
 *      betaaltermijn_dagen 14, status 'actief') — de SQL-DEFAULTs van migratie
 *      0002;
 *     - CHECK-constraints falen correct bij ongeldige waarden;
 *     - `persoon.email` (citext) is case-insensitief uniek;
 *     - Drizzle insert + select op beide tabellen, typeveilig via het schema.
 *
 * Elke test gebruikt een eigen unieke waarde zodat de tests onafhankelijk zijn
 * van de uitvoer-ordening.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';
import { vve } from '../src/database/schema/vve.js';
import { persoon } from '../src/database/schema/persoon.js';

describe('Schema vve/persoon (F03)', () => {
  let db: TestPgDb | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('vve.insert met defaults vult de DEFAULT-kolommen', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const [rij] = await db.db.insert(vve).values({ naam: 'Apartmenten VvE De Dennen' }).returning();

    if (!rij) throw new Error('insert leverde geen rij op');
    expect(rij.breukdeelNoemer).toBe(1000);
    expect(rij.boekjaarStartmaand).toBe(1);
    expect(rij.betaaltermijnDagen).toBe(14);
    expect(rij.status).toBe('actief');
    expect(rij.naam).toBe('Apartmenten VvE De Dennen');
  });

  it('CHECK: breukdeel_noemer > 0 faalt op 0', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    await expect(
      db.db.insert(vve).values({ naam: 'Nul-noemer', breukdeelNoemer: 0 }).returning(),
    ).rejects.toThrow();
  });

  it('CHECK: boekjaar_startmaand 1..12 faalt op 13', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    await expect(
      db.db.insert(vve).values({ naam: 'Dertien-deuren', boekjaarStartmaand: 13 }).returning(),
    ).rejects.toThrow();
  });

  it('CHECK: herbouwwaarde_cent >= 0 faalt op -1', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');
    await expect(
      db.db
        .insert(vve)
        .values({ naam: 'Negatie', herbouwwaardeCent: BigInt(-1) })
        .returning(),
    ).rejects.toThrow();
  });

  it('persoon.email is case-insensitief uniek (citext)', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    await db.db
      .insert(persoon)
      .values({ email: 'Test@voorbeeld.nl', achternaam: 'Doe' })
      .returning();

    // Alleen de case gewijzigd: een case-gevoelige uniek-constraint zou
    // dit toelaten; de citext-constraint faalt (dat is precies de test).
    await expect(
      db.db.insert(persoon).values({ email: 'test@voorbeeld.nl', achternaam: 'Doe' }).returning(),
    ).rejects.toThrow();
  });

  it('Drizzle round-trip: persoon insert + select via het schema', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    const [ing] = await db.db
      .insert(persoon)
      .values({
        email: 'roundtrip@voorbeeld.nl',
        achternaam: 'Van Roundtrip',
        corrLand: 'ES',
        actief: true,
      })
      .returning({ id: persoon.id });

    if (!ing) throw new Error('persoon-insert leverde geen rij op');

    const gevonden = await db.db.select().from(persoon).where(eq(persoon.id, ing.id));

    const rij = gevonden[0];
    if (!rij) throw new Error('persoon niet gevonden');
    expect(rij.achternaam).toBe('Van Roundtrip');
    expect(rij.email.toLowerCase()).toBe('roundtrip@voorbeeld.nl');
  });

  it('Drizzle round-trip: vve insert + select met where-clause', async () => {
    if (!db) throw new Error('beforeAll slaagde niet: geen test-db');

    await db.db
      .insert(vve)
      .values({
        naam: 'VvE Roundtrip',
        kvkNummer: '12345678',
        modelreglement: 'MR2017',
      })
      .returning({ id: vve.id });

    const gevonden = await db.db.select().from(vve).where(eq(vve.kvkNummer, '12345678'));

    const rij = gevonden[0];
    if (!rij) throw new Error('vve niet gevonden');
    expect(rij.naam).toBe('VvE Roundtrip');
    expect(rij.modelreglement).toBe('MR2017');
  });
});
