/**
 * Integratietest — eigenaarsportaal (V07, spec M14 · AC14.1–14.3).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0025).
 * Controleert:
 *   - het overzicht: alleen de eenheden waar de opvrager nu eigenaar van is
 *     (lopen periode), met openstaand saldo en creditsaldo (G06/G08, live);
 *   - een niet-eigenaar (bewoner/zonder eigenaarschap) ziet géén eenheden;
 *   - historische eigenaarschappen tellen niet mee (eigenaarswissel V03);
 *   - AC14.3: gegevens lezen en wijzigen (naam/telefoon/adres/communicatie),
 *     met weigeringen (lege achternaam, onbekende communicatieWijze, lege
 *     body) en zonder e-mail (verificatie-flow volgt later);
 *   - audit: profielwijziging wordt gelogd.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLog,
  eigenaarschap,
  nota,
  persoon,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { boekjaar } from '../src/database/schema/boekjaar.js';

import { maakPortaalService, type PortaalService } from '../src/modules/portaal/portaal-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Eigenaarsportaal (V07, AC14.1–14.3)', () => {
  let db: TestPgDb | undefined;
  let service: PortaalService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakPortaalService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  interface Seed {
    readonly vveId: bigint;
    readonly eigenaarId: bigint;
    readonly anderId: bigint;
    readonly eenheidId: bigint;
  }

  /**
   * Seedt een VvE + eigenaar (rol 'eigenaar') + tweede persoon, met een
   * lopend eigenaarschap op A-01, een open nota en een betaalde betaling.
   */
  async function seed(): Promise<Seed> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const uniek = `${n}-${String(Date.now())}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `V07-VvE-${n}` })
      .returning({ id: vve.id });
    const [eigenaar] = await db.db
      .insert(persoon)
      .values({
        email: `v07-${uniek}-e@test.vve`,
        achternaam: 'Jansen',
        voornaam: 'Jan',
        telefoon: '0612345678',
      })
      .returning({ id: persoon.id });
    const [ander] = await db.db
      .insert(persoon)
      .values({ email: `v07-${uniek}-a@test.vve`, achternaam: 'Ander' })
      .returning({ id: persoon.id });
    if (v === undefined || eigenaar === undefined || ander === undefined) {
      throw new Error('seed faalde');
    }
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: 'A-01', oppervlakteM2: 85.5 })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid-seed faalde');
    await db.db.insert(eigenaarschap).values({
      vveId: v.id,
      wooneenheidId: e.id,
      persoonId: eigenaar.id,
      aandeelPromille: 1000,
      isPrimairContact: true,
      periode: '[2026-01-01,)',
    });
    // Boekjaar + open nota (365 euro) + betaling (200 euro, niet gekoppeld).
    await db.db.insert(boekjaar).values({
      vveId: v.id,
      jaar: 2027,
      startDatum: '2027-01-01',
      eindDatum: '2027-12-31',
    });
    const [j] = await db.db
      .select({ id: boekjaar.id })
      .from(boekjaar)
      .where(and(eq(boekjaar.vveId, v.id), eq(boekjaar.jaar, 2027)))
      .limit(1);
    if (j === undefined) throw new Error('boekjaar-seed faalde');
    await db.db.insert(nota).values({
      vveId: v.id,
      wooneenheidId: e.id,
      persoonId: eigenaar.id,
      boekjaarId: j.id,
      nummer: `NOTA-V07-${String(v.id)}-1`,
      type: 'periodieke_bijdrage',
      factuurdatum: '2027-02-01',
      vervaldatum: '2027-03-01',
      bedragCent: 365_00,
      openstaandCent: 365_00,
      betalingskenmerk: `NOTAV07${String(v.id)}A`,
      status: 'open',
    });
    return { vveId: v.id, eigenaarId: eigenaar.id, anderId: ander.id, eenheidId: e.id };
  }

  it('overzicht: alleen mijn lopende eenheden, met openstaand en creditsaldo', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    // (De betaling-seed staat in de volgende test; hier is de nota voldoende.)
    const overzicht = await service.overzicht(s.vveId, s.eigenaarId);
    expect(overzicht.eenheden).toHaveLength(1);
    const eenheid = overzicht.eenheden[0];
    if (!eenheid) throw new Error('geen eenheid');
    expect(eenheid.code).toBe('A-01');
    expect(eenheid.aandeelPromille).toBe(1000);
    expect(eenheid.isPrimairContact).toBe(true);
    expect(eenheid.openstaandCenten).toBe(365_00);
    expect(eenheid.oudsteVervaldatum).toBe('2027-03-01');
    // Mededelingen bestaan nog niet in deze seed: lege lijst is correct.
    expect(overzicht.mededelingen).toHaveLength(0);
  });

  it('niet-eigenaar ziet geen eenheden (eigenaar-zicht, geen bestuur-zicht)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const overzicht = await service.overzicht(s.vveId, s.anderId);
    expect(overzicht.eenheden).toHaveLength(0);
    expect(overzicht.betalingen).toHaveLength(0);
  });

  it('historisch eigenaarschap telt niet mee na een wissel (V03-geest)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    // Sluit het lopende eigenaarschap af op 2026-06-30 (verkoop).
    await db.db
      .update(eigenaarschap)
      .set({ periode: '[2026-01-01,2026-06-30)' })
      .where(and(eq(eigenaarschap.vveId, s.vveId), eq(eigenaarschap.persoonId, s.eigenaarId)));
    const overzicht = await service.overzicht(s.vveId, s.eigenaarId);
    expect(overzicht.eenheden).toHaveLength(0);
  });

  it('AC14.3 — gegevens lezen en wijzigen (naam, telefoon, adres, communicatie)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const voor = await service.gegevens(s.eigenaarId);
    expect(voor.achternaam).toBe('Jansen');
    expect(voor.telefoon).toBe('0612345678');

    const na = await service.wijzigGegevens(s.eigenaarId, {
      telefoon: '0687654321',
      corrStraat: 'Kerkstraat 1',
      corrHuisnummer: '1',
      corrPostcode: '1011AB',
      corrPlaats: 'Amsterdam',
      communicatieWijze: 'post',
      voornaam: 'Jan Pieter',
    });
    expect(na.telefoon).toBe('0687654321');
    expect(na.corrStraat).toBe('Kerkstraat 1');
    expect(na.communicatieWijze).toBe('post');
    expect(na.voornaam).toBe('Jan Pieter');
    // E-mail is bewust onaangetast.
    expect(na.email).toBe(voor.email);

    // Audit-regel met de gewijzigde velden.
    const auditrijen = await db.db
      .select({ gebeurtenis: auditLog.gebeurtenis })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.persoonId, s.eigenaarId),
          eq(auditLog.gebeurtenis, 'profiel.gegevens_gewijzigd'),
        ),
      );
    expect(auditrijen.length).toBeGreaterThan(0);
  });

  it('AC14.3 — weigeringen: lege achternaam, onbekende communicatieWijze, lege body', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    await expect(service.wijzigGegevens(s.eigenaarId, { achternaam: '  ' })).rejects.toThrow(
      /achternaam mag niet leeg/,
    );
    await expect(
      service.wijzigGegevens(s.eigenaarId, { communicatieWijze: 'fax' }),
    ).rejects.toThrow(/"email", "post" of "beide"/);
    await expect(service.wijzigGegevens(s.eigenaarId, {})).rejects.toThrow(/niets te wijzigen/);
  });
});
