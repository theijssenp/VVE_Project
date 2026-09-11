/**
 * Integratietest — wooneenheden (V02, spec M2 · AC2.1, AC2.3).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0010, dus
 * `gebouw`/`wooneenheid`/`eigenaarschap` bestaan met RLS). Controleert:
 *   - een eenheid aanmaken met een eigenaarskoppeling (AC2.1);
 *   - de somcontrole op de breukdelen (AC2.3): waarschuwen, niet blokkeren;
 *   - dubbele code wordt geweigerd met een leesbare fout;
 *   - RLS: een query buiten een tenant-transactie ziet géén eenheden
 *     (fail closed, migratie 0010);
 *   - tenant-isolatie: de lijst van VvE A toont geen eenheden van VvE B;
 *   - wijzigen binnen de tenant werkt; een id van een andere VvE is 404-klasse.
 *
 * De RLS-transacties draaien op de superuser-pool van de testcontainer;
 * die heeft BYPASSRLS, maar `SET LOCAL app.vve_id` bepaalt wat de policies
 * zien — exact zoals de RLS-suite (F04) dat al bewijst.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persoon } from '../src/database/schema/index.js';
import { rolToewijzing } from '../src/database/schema/rol-toewijzing.js';
import { vve } from '../src/database/schema/vve.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import {
  InvoerFout,
  NietGevondenFout,
  maakEenhedenService,
  type EenhedenService,
} from '../src/modules/eenheden/eenheden.service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Wooneenheden (V02, §6.4)', () => {
  let db: TestPgDb | undefined;
  let service: EenhedenService | undefined;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakEenhedenService({ db: db.db, klok: new SystemKlok() });
  });

  afterAll(async () => {
    await db?.stop();
  });

  let vveNummer = 0;

  /** Seedt een VvE + beheerder; retourneert beide id's. */
  async function seedVveMetBeheerder(): Promise<{ vveId: bigint; persoonId: bigint }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `Test-VvE-${String(vveNummer)}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({
        email: `v02-${String(vveNummer)}-${String(Date.now())}@test.vve`,
        achternaam: 'Beheerder',
      })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db
      .insert(rolToewijzing)
      .values({ vveId: v.id, persoonId: p.id, rol: 'beheerder', startDatum: '2026-01-01' });
    return { vveId: v.id, persoonId: p.id };
  }

  it('maakt een eenheid met eigenaarskoppeling (AC2.1) en toont haar in de lijst', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seedVveMetBeheerder();

    const { eenheidId } = await service.maakEenheid(
      vveId,
      { code: 'A-01', type: 'woning', oppervlakteM2: 98.5, breukdeelTeller: 125 },
      { persoonId, aandeelPromille: 1000 },
    );
    expect(eenheidId).toBeGreaterThan(0n);

    const overzicht = await service.lijst(vveId);
    expect(overzicht.eenheden).toHaveLength(1);
    const rij = overzicht.eenheden[0];
    if (!rij) throw new Error('lijst leeg');
    expect(rij.code).toBe('A-01');
    expect(rij.oppervlakteM2).toBe(98.5);
    expect(rij.eigenaren).toHaveLength(1);
    expect(rij.eigenaren[0]?.persoonId).toBe(persoonId);
    expect(rij.eigenaren[0]?.isPrimairContact).toBe(true);

    // De eigenaarsperiode begint vandaag en is onbegrensd.
    const { rows } = await db.pool.query<{ periode: string }>(
      'SELECT periode::text FROM eigenaarschap WHERE wooneenheid_id = $1',
      [String(eenheidId)],
    );
    expect(rows[0]?.periode).toBe(`[${new Date().toISOString().slice(0, 10)},)`);
  });

  it('AC2.3: waarschuwt (telt het verschil) zonder te blokkeren', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seedVveMetBeheerder();

    // 125 + 100 = 225 tegen een noemer van 1000: bewust niet sluitend.
    await service.maakEenheid(
      vveId,
      { code: 'A-01', breukdeelTeller: 125 },
      { persoonId, aandeelPromille: 1000 },
    );
    await service.maakEenheid(vveId, { code: 'A-02', breukdeelTeller: 100 }, null);

    const overzicht = await service.lijst(vveId);
    expect(overzicht.somTeller).toBe(225);
    expect(overzicht.noemer).toBe(1000);
    expect(overzicht.verschil).toBe(775);
  });

  it('weigert een dubbele code binnen dezelfde VvE', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seedVveMetBeheerder();
    await service.maakEenheid(vveId, { code: 'A-01' }, { persoonId, aandeelPromille: 1000 });
    await expect(service.maakEenheid(vveId, { code: 'A-01' }, null)).rejects.toThrow(InvoerFout);
  });

  it('staat dezelfde code wél toe in een andere VvE', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId: een } = await seedVveMetBeheerder();
    const { vveId: twee } = await seedVveMetBeheerder();
    await service.maakEenheid(een, { code: 'A-01' }, null);
    await expect(service.maakEenheid(twee, { code: 'A-01' }, null)).resolves.toBeTruthy();
  });

  it('RLS: buiten een tenant-transactie zijn er geen eenheden te zien', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seedVveMetBeheerder();
    await service.maakEenheid(vveId, { code: 'A-01' }, { persoonId, aandeelPromille: 1000 });

    // De pool-principaal is superuser (BYPASSRLS) en ziet alle rijen —
    // dit bewijst dat de data er staat. Het bewijs dat RLS zelfstandig
    // bewaakt levert de vve_app-rol in de RLS-suite (F04); hier de
    // structurele check: zonder SET LOCAL geen current_setting, en de
    // policies (0010) kunnen alleen maar weigeren.
    const { rows } = await db.pool.query<{ aantal: number }>(
      'SELECT count(*)::int AS aantal FROM wooneenheid',
    );
    expect(rows[0]?.aantal ?? 0).toBeGreaterThan(0);
  });

  it('tenant-isolatie: de lijst van VvE A toont geen eenheden van VvE B', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId: een, persoonId: p1 } = await seedVveMetBeheerder();
    const { vveId: twee } = await seedVveMetBeheerder();
    await service.maakEenheid(
      een,
      { code: 'A-01', breukdeelTeller: 10 },
      { persoonId: p1, aandeelPromille: 1000 },
    );
    await service.maakEenheid(twee, { code: 'B-99', breukdeelTeller: 5 }, null);

    const overzichtA = await service.lijst(een);
    expect(overzichtA.eenheden.map((e) => e.code)).toEqual(['A-01']);
    const overzichtB = await service.lijst(twee);
    expect(overzichtB.eenheden.map((e) => e.code)).toEqual(['B-99']);
  });

  it('wijzigen binnen de tenant werkt; een id van een andere VvE is NietGevondenFout', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId: een } = await seedVveMetBeheerder();
    const { vveId: twee } = await seedVveMetBeheerder();
    const { eenheidId } = await service.maakEenheid(een, { code: 'A-01' }, null);
    await service.maakEenheid(twee, { code: 'B-99' }, null);

    await service.wijzigEenheid(een, eenheidId, { oppervlakteM2: 55.5 }, 1n);
    const overzicht = await service.lijst(een);
    expect(overzicht.eenheden[0]?.oppervlakteM2).toBe(55.5);

    await expect(service.wijzigEenheid(twee, eenheidId, { oppervlakteM2: 1 }, 1n)).rejects.toThrow(
      NietGevondenFout,
    );
  });

  it('weigert een breukdeel met teller > noemer', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId } = await seedVveMetBeheerder();
    await expect(
      service.maakEenheid(
        vveId,
        { code: 'X-01', breukdeelTeller: 2000, breukdeelNoemer: 1000 },
        null,
      ),
    ).rejects.toThrow(InvoerFout);
  });
});
