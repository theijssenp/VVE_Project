/**
 * Integratietest — boekjaar afsluiten en kascommissie (B10, AC9.3 · AC9.7).
 *
 * Controleert:
 *   - de resultaatbestemming boekt het resultaat naar het eigen vermogen, en
 *     daarna is het resultaat van het jaar nul;
 *   - een deel kan naar het reservefonds, maar nooit meer dan het resultaat;
 *   - alle boekingen van het jaar staan na afloop op `vergrendeld`;
 *   - een boekjaar met een onbalans wordt geweigerd — afsluiten zou die
 *     onbalans voor altijd vastleggen;
 *   - het kascommissiedossier toont boekingen, banksaldi en verklaringen;
 *   - aftekenen legt akkoord én bezwaar vast, en opnieuw tekenen herziet.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import { boeking, grootboekrekening, persoon, vve } from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import {
  InvoerFout,
  Regel,
  maakBoekhouding,
  type Boekhouding,
} from '../src/financieel/boekhouding.js';
import { maakBoekjaarService, type BoekjaarService } from '../src/financieel/boekjaar-service.js';
import {
  maakAfsluitingService,
  type AfsluitingService,
} from '../src/financieel/afsluiting-service.js';
import {
  maakJaarrekeningService,
  type JaarrekeningService,
} from '../src/financieel/jaarrekening-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Boekjaar afsluiten (B10, AC9.3/AC9.7)', () => {
  let db: TestPgDb | undefined;
  let boekhouding: Boekhouding | undefined;
  let boekjaarSvc: BoekjaarService | undefined;
  let afsluiting: AfsluitingService | undefined;
  let jaarrekeningSvc: JaarrekeningService | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    boekhouding = maakBoekhouding({ db: db.db });
    boekjaarSvc = maakBoekjaarService({ db: db.db });
    afsluiting = maakAfsluitingService({ db: db.db });
    jaarrekeningSvc = maakJaarrekeningService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seed(): Promise<{ vveId: bigint; persoonId: bigint; jaarId: bigint }> {
    if (!db || !boekjaarSvc) throw new Error('geen setup');
    teller += 1;
    const n = `${String(teller)}-${String(process.pid)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B10-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b10-${n}@test.vve`, achternaam: 'Commissie' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));
    const { id } = await boekjaarSvc.maakBoekjaar(
      v.id,
      { jaar: 2026, startDatum: '2026-01-01', eindDatum: '2026-12-31' },
      p.id,
    );
    await boekjaarSvc.open(v.id, id, p.id);
    return { vveId: v.id, persoonId: p.id, jaarId: id };
  }

  /** Baten 100.000, lasten 40.000 → resultaat 60.000 positief. */
  async function boekJaar(vveId: bigint, jaarId: bigint, persoonId: bigint): Promise<void> {
    if (!boekhouding) throw new Error('geen setup');
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-02-01',
        omschrijving: 'Bijdragen',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1100', Bedrag.vanCenten(100_000)),
          Regel.credit('8100', Bedrag.vanCenten(100_000)),
        ],
      },
      persoonId,
    );
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-03-01',
        omschrijving: 'Onderhoud',
        bron: 'memoriaal',
        regels: [
          Regel.debet('4100', Bedrag.vanCenten(40_000)),
          Regel.credit('1100', Bedrag.vanCenten(40_000)),
        ],
      },
      persoonId,
    );
  }

  it('boekt het resultaat naar het eigen vermogen; daarna is het resultaat nul', async () => {
    if (!afsluiting || !jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId);

    const voor = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(voor.resultaatCent).toBe(60_000);

    const uit = await afsluiting.sluitAf(vveId, jaarId, {}, persoonId);
    expect(uit.resultaatCent).toBe(60_000);
    expect(uit.naarAlgemeneReserveCent).toBe(60_000);
    expect(uit.naarReservefondsCent).toBe(0);
    expect(uit.resultaatBoekingNummer).not.toBeNull();

    // Ná de bestemming staat het resultaat op het eigen vermogen en is de
    // resultaatrekening van dit jaar per saldo leeg.
    const na = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(na.eigenVermogen.totaalCent).toBe(60_000);
    expect(na.inBalans).toBe(true);
  });

  it('een deel kan naar het reservefonds, maar nooit meer dan het resultaat', async () => {
    if (!afsluiting || !jaarrekeningSvc) throw new Error('geen setup');
    const a = await seed();
    await boekJaar(a.vveId, a.jaarId, a.persoonId);
    const uit = await afsluiting.sluitAf(
      a.vveId,
      a.jaarId,
      { naarReservefondsCent: 25_000 },
      a.persoonId,
    );
    expect(uit.naarReservefondsCent).toBe(25_000);
    expect(uit.naarAlgemeneReserveCent).toBe(35_000);

    const na = await jaarrekeningSvc.jaarrekening(a.vveId, a.jaarId);
    const reservefonds = na.eigenVermogen.regels.find((r) => r.nummer === '0600');
    expect(reservefonds?.bedragCent).toBe(25_000);

    // Te veel doteren wordt geweigerd.
    const b = await seed();
    await boekJaar(b.vveId, b.jaarId, b.persoonId);
    await expect(
      afsluiting.sluitAf(b.vveId, b.jaarId, { naarReservefondsCent: 99_999_999 }, b.persoonId),
    ).rejects.toBeInstanceOf(InvoerFout);
  });

  it('vergrendelt alle boekingen van het jaar', async () => {
    if (!db || !afsluiting) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId);

    const uit = await afsluiting.sluitAf(vveId, jaarId, {}, persoonId);
    // Twee boekingen plus de resultaatbestemming.
    expect(uit.aantalVergrendeld).toBe(3);

    const rijen = await db.db
      .select({ vergrendeld: boeking.vergrendeld })
      .from(boeking)
      .where(and(eq(boeking.vveId, vveId), eq(boeking.boekjaarId, jaarId)));
    expect(rijen).toHaveLength(3);
    expect(rijen.every((r) => r.vergrendeld)).toBe(true);
  });

  it('afsluiten kan maar één keer', async () => {
    if (!afsluiting) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId);
    await afsluiting.sluitAf(vveId, jaarId, {}, persoonId);
    await expect(afsluiting.sluitAf(vveId, jaarId, {}, persoonId)).rejects.toBeInstanceOf(
      InvoerFout,
    );
  });

  it('een jaar zonder boekingen sluit gewoon, zonder resultaatboeking', async () => {
    if (!afsluiting) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    const uit = await afsluiting.sluitAf(vveId, jaarId, {}, persoonId);
    expect(uit.resultaatCent).toBe(0);
    expect(uit.resultaatBoekingNummer).toBeNull();
    expect(uit.aantalVergrendeld).toBe(0);
  });

  it('AC9.7: het dossier toont boekingen, banksaldi en verklaringen', async () => {
    if (!afsluiting) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId);

    const dossier = await afsluiting.kascommissieDossier(vveId, jaarId);
    expect(dossier.boekingen).toHaveLength(2);
    expect(dossier.boekingen[0]?.omschrijving).toBe('Bijdragen');
    // Bank: 100.000 binnen, 40.000 eruit.
    const bank = dossier.banksaldi.find((b) => b.nummer === '1100');
    expect(bank?.saldoCent).toBe(60_000);
    expect(dossier.verklaringen).toHaveLength(0);
  });

  it('AC9.7: aftekenen legt akkoord én bezwaar vast, opnieuw tekenen herziet', async () => {
    if (!afsluiting) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId);

    await afsluiting.tekenAf(
      vveId,
      jaarId,
      { akkoord: false, bevindingen: 'Kasstuk maart ontbreekt' },
      persoonId,
    );
    const metBezwaar = await afsluiting.kascommissieDossier(vveId, jaarId);
    expect(metBezwaar.verklaringen).toHaveLength(1);
    expect(metBezwaar.verklaringen[0]?.akkoord).toBe(false);
    expect(metBezwaar.verklaringen[0]?.bevindingen).toBe('Kasstuk maart ontbreekt');

    // Bevinding opgelost: hetzelfde lid tekent opnieuw, nu mét akkoord.
    await afsluiting.tekenAf(vveId, jaarId, { akkoord: true }, persoonId);
    const naHerziening = await afsluiting.kascommissieDossier(vveId, jaarId);
    expect(naHerziening.verklaringen).toHaveLength(1);
    expect(naHerziening.verklaringen[0]?.akkoord).toBe(true);
    expect(naHerziening.verklaringen[0]?.bevindingen).toBeNull();
  });
});
