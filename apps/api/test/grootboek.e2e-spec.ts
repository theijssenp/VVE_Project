/**
 * Integratietest — grootboek (G01, spec §5.7, §6.7 · AC9.1).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0013).
 * Controleert:
 *   - het standaard schema (38 rekeningen, exact §5.7) wordt bij de
 *     VvE-aanmaak gekopieerd — inclusief 4950/8150 (dotatie-paar);
 *   - kopieëren is idempotent (tweede keer voegt niets toe);
 *   - rekening toevoegen met een dubbel nummer wordt geweigerd;
 *   - wijzigen binnen de tenant werkt; een id van een andere VvE is
 *     NietGevondenFout (tenant-isolatie);
 *   - de categorie is een enum: onbekende waarden worden geweigerd.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grootboekrekening, persoon, vve } from '../src/database/schema/index.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import {
  InvoerFout,
  NietGevondenFout,
  maakGrootboekService,
  type GrootboekService,
} from '../src/financieel/grootboek-service.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Grootboek (G01, §5.7/§6.7)', () => {
  let db: TestPgDb | undefined;
  let service: GrootboekService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakGrootboekService({ db: db.db, klok: new SystemKlok() });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt een kale VvE (zonder schema — dat doet de service zelf). */
  async function kaleVve(): Promise<bigint> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G01-VvE-${String(vveNummer)}` })
      .returning({ id: vve.id });
    if (v === undefined) throw new Error('seed faalde');
    return v.id;
  }

  /** Seedt een VvE mét het §5.7-schema, zoals de vve-service dat doet. */
  async function vveMetSchema(): Promise<bigint> {
    if (!db || !service) throw new Error('geen setup');
    const vveId = await kaleVve();
    const { standaardGrootboekschema } = await import('../src/financieel/grootboek-schema.js');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(vveId));
    return vveId;
  }

  it('het standaard schema bevat precies de rekeningen uit §5.7 (37 stuks)', () => {
    const schema = standaardGrootboekschema(1n);
    expect(schema).toHaveLength(37);
    const nummers = schema.map((r) => r.nummer);
    // De dotatie-paar dat de reservefondsdotatie zichtbaar door de exploitatie laat lopen:
    expect(nummers).toContain('4950');
    expect(nummers).toContain('8150');
    expect(nummers).toContain('0600'); // reservefonds op de balans
    // Balans-/lasten-/batenverdeling volgens §5.7 (11 + 20 + 6):
    expect(schema.filter((r) => r.categorie === 'activa')).toHaveLength(5);
    expect(schema.filter((r) => r.categorie === 'passiva')).toHaveLength(3);
    expect(schema.filter((r) => r.categorie === 'eigen_vermogen')).toHaveLength(3);
    expect(schema.filter((r) => r.categorie === 'lasten')).toHaveLength(20);
    expect(schema.filter((r) => r.categorie === 'baten')).toHaveLength(6);
  });

  it('kopieëren is idempotent en vult alle categorieën', async () => {
    if (!db || !service) throw new Error('geen setup');
    const vveId = await kaleVve();
    const eerste = await service.kopieerStandaardSchema(vveId);
    expect(eerste.aantal).toBe(37);
    const tweede = await service.kopieerStandaardSchema(vveId);
    expect(tweede.aantal).toBe(0);

    const rijen = await service.lijst(vveId);
    expect(rijen).toHaveLength(37);
    const nummers = rijen.map((r) => r.nummer);
    expect(new Set(nummers).size).toBe(37); // allemaal uniek
  });

  /** Seedt een echte persoon (FK-target voor het auditlog). */
  async function persoonId(): Promise<bigint> {
    if (!db) throw new Error('geen test-db');
    const [p] = await db.db
      .insert(persoon)
      .values({
        email: `g01-${String(Date.now())}-${String(vveNummer)}@test.vve`,
        achternaam: 'G01',
      })
      .returning({ id: persoon.id });
    if (p === undefined) throw new Error('persoon-seed faalde');
    return p.id;
  }

  it('toevoegen met een dubbel nummer wordt geweigerd', async () => {
    if (!db || !service) throw new Error('geen setup');
    const vveId = await vveMetSchema();
    const wie = await persoonId();
    await expect(
      service.voegToe(vveId, { nummer: '1000', naam: 'Dubbel', categorie: 'activa' }, wie),
    ).rejects.toThrow(InvoerFout);
  });

  it('wijzigen binnen de tenant werkt; andere VvE is NietGevondenFout', async () => {
    if (!db || !service) throw new Error('geen setup');
    const een = await vveMetSchema();
    const twee = await vveMetSchema();
    const wie = await persoonId();
    const [rij] = await db.db
      .select({ id: grootboekrekening.id })
      .from(grootboekrekening)
      .where(and(eq(grootboekrekening.vveId, een), eq(grootboekrekening.nummer, '1000')))
      .limit(1);
    if (rij === undefined) throw new Error('rekening 1000 ontbreekt');

    await service.wijzig(een, rij.id, { naam: 'Kas (aangepast)', actief: false }, wie);
    const [na] = await db.db
      .select()
      .from(grootboekrekening)
      .where(eq(grootboekrekening.id, rij.id))
      .limit(1);
    expect(na?.naam).toBe('Kas (aangepast)');
    expect(na?.actief).toBe(false);

    await expect(service.wijzig(twee, rij.id, { actief: true }, wie)).rejects.toThrow(
      NietGevondenFout,
    );
  });

  it('weigert een onbekende categorie', async () => {
    if (!db || !service) throw new Error('geen setup');
    const vveId = await vveMetSchema();
    await expect(
      service.voegToe(vveId, { nummer: '9900', naam: 'Onzin', categorie: 'winst' }, 1n),
    ).rejects.toThrow(InvoerFout);
  });
});
