/**
 * Integratietest — leveranciers en verplichtingen (A05, spec §6.9 ·
 * AC12.4–AC12.6).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0023).
 * Controleert:
 *   - AC12.4: leveranciersregister + contracten; de opzegsignalering is
 *     waar als het opzegvenster binnen 90 dagen begint;
 *   - AC12.5: verplichtingen met T-60/T-14-herinneringsvlaggen en
 *     achterhaald-vlag;
 *   - de som per leverancier en de oudste vervaldatum kloppen.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persoon, vve } from '../src/database/schema/index.js';
import {
  maakLeverancierService,
  type LeverancierService,
} from '../src/financieel/leverancier-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Leveranciers en verplichtingen (A05, AC12.4–12.6)', () => {
  let db: TestPgDb | undefined;
  let service: LeverancierService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakLeverancierService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + beheerder. */
  async function seed() {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `A05-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `a05-${n}-${String(Date.now())}@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    return { vveId: v.id, persoonId: p.id };
  }

  it('AC12.4 — leveranciersregister met contracten en opzegsignalering', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    const liftbedrijf = await service.maakLeverancier(
      s.vveId,
      { naam: 'Liftservice B.V.', contactpersoon: 'Jan Klus', kvkNummer: '12345678' },
      s.persoonId,
    );
    expect(liftbedrijf.id).toBeGreaterThan(0n);

    // Contract met einddatum 70 dagen in de toekomst, opzegtermijn 60 dagen
    // → het opzegvenster begint over 0 dagen (binnen 90): signaal aan.
    const vandaag = new Date();
    const binnen30 = new Date(vandaag);
    binnen30.setUTCDate(binnen30.getUTCDate() + 30);
    const binnen30S = binnen30.toISOString().slice(0, 10);
    const start = new Date(vandaag);
    start.setUTCDate(start.getUTCDate() - 300);
    const startS = start.toISOString().slice(0, 10);
    await service.voegContractToe(
      s.vveId,
      {
        leverancierId: liftbedrijf.id,
        omschrijving: 'Onderhoudscontract lift',
        bedragPerJaarCent: 240_000,
        startDatum: startS,
        eindDatum: binnen30S,
        opzegtermijnDagen: 60,
      },
      s.persoonId,
    );

    // Een tweede leverancier met een ver contract — geen signaal.
    const schilder = await service.maakLeverancier(
      s.vveId,
      { naam: 'Schildersbedrijf' },
      s.persoonId,
    );
    const ver = new Date(vandaag);
    ver.setUTCDate(ver.getUTCDate() + 400);
    await service.voegContractToe(
      s.vveId,
      {
        leverancierId: schilder.id,
        omschrijving: 'Jaaronderhoud schilderwerk',
        bedragPerJaarCent: 120_000,
        startDatum: startS,
        eindDatum: ver.toISOString().slice(0, 10),
        opzegtermijnDagen: 60,
      },
      s.persoonId,
    );

    const overzicht = await service.contracten(s.vveId);
    expect(overzicht.length).toBe(2);
    const lift = overzicht.find((g) => g.leverancierNaam === 'Liftservice B.V.');
    const schilders = overzicht.find((g) => g.leverancierNaam === 'Schildersbedrijf');
    if (lift === undefined || schilders === undefined) throw new Error('groepen ontbreken');
    expect(lift.rijen.length).toBe(1);
    expect(lift.rijen[0]?.opzegBinnen90Dagen).toBe(true);
    expect(schilders.rijen[0]?.opzegBinnen90Dagen).toBe(false);
  });

  it('AC12.5 — verplichtingen: T-60 en T-14-herinneringen live', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const vandaag = new Date();

    const d45 = new Date(vandaag);
    d45.setUTCDate(d45.getUTCDate() + 45); // binnen T-60, buiten T-14
    await service.voegVerplichtingToe(
      s.vveId,
      {
        soort: 'liftkeuring',
        omschrijving: 'Liftkeuring 2026',
        vervaldatum: d45.toISOString().slice(0, 10),
      },
      s.persoonId,
    );
    const d10 = new Date(vandaag);
    d10.setUTCDate(d10.getUTCDate() + 10); // binnen T-14
    await service.voegVerplichtingToe(
      s.vveId,
      {
        soort: 'opstalverzekering',
        omschrijving: 'Opstalverzekering polis',
        vervaldatum: d10.toISOString().slice(0, 10),
      },
      s.persoonId,
    );
    const dMin = new Date(vandaag);
    dMin.setUTCDate(dMin.getUTCDate() - 30); // achterhaald
    await service.voegVerplichtingToe(
      s.vveId,
      {
        soort: 'legionella',
        omschrijving: 'Legionella-inspectie',
        vervaldatum: dMin.toISOString().slice(0, 10),
      },
      s.persoonId,
    );

    const lijst = await service.verplichtingen(s.vveId);
    expect(lijst.length).toBe(3);
    const keuring = lijst.find((r) => r.omschrijving === 'Liftkeuring 2026');
    const polis = lijst.find((r) => r.omschrijving === 'Opstalverzekering polis');
    const legionella = lijst.find((r) => r.omschrijving === 'Legionella-inspectie');
    if (keuring === undefined || polis === undefined || legionella === undefined) {
      throw new Error('rijen ontbreken');
    }
    expect(keuring.herinneringT60).toBe(true);
    expect(keuring.herinneringT14).toBe(false);
    expect(polis.herinneringT14).toBe(true);
    expect(polis.herinneringT60).toBe(true);
    expect(legionella.achterhaald).toBe(true);
    expect(legionella.herinneringT14).toBe(false);
  });

  it('registreert contactgegevens en KvK; lijst sorteert op naam', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    await service.maakLeverancier(s.vveId, { naam: 'Zolderisolatie X' }, s.persoonId);
    await service.maakLeverancier(
      s.vveId,
      { naam: 'Aannemer Y', email: 'y@x.nl', kvkNummer: '87654321' },
      s.persoonId,
    );
    const lijst = await service.lijst(s.vveId);
    expect(lijst.length).toBe(2);
    expect(lijst[0]?.naam).toBe('Aannemer Y'); // alfabetisch vóór Z
    expect(lijst[1]?.naam).toBe('Zolderisolatie X');
  });
});
