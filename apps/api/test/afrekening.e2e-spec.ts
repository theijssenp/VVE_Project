/**
 * Integratietest — afrekening servicekosten (B09, M9 · AC9.5–9.6, tests #22–23).
 *
 * Test #22: werkelijke kosten − voorschotten per eenheid, en de som van de
 * saldi gelijk aan het exploitatieresultaat (met omgekeerd teken: een saldo is
 * wat de eigenaar nog moet bijleggen, een resultaat is wat de VvE overhield).
 *
 * Test #23: een eigenaarswissel halverwege het jaar verdeelt het saldo pro rata
 * over de dagen, en de twee delen tellen exact op tot het geheel.
 *
 * Beide worden hier met de hand nagerekend. Bij #23 staat de rekensom in de
 * test zelf, want een pro-rataverdeling die zichzelf bevestigt bewijst niets.
 */

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import {
  begroting,
  begrotingsregel,
  eigenaarschap,
  grootboekrekening,
  nota,
  persoon,
  verdeelsleutel,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { Regel, maakBoekhouding, type Boekhouding } from '../src/financieel/boekhouding.js';
import { maakBoekjaarService, type BoekjaarService } from '../src/financieel/boekjaar-service.js';
import {
  dagenInclusief,
  maakAfrekeningService,
  type AfrekeningService,
} from '../src/financieel/afrekening-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Afrekening servicekosten (B09, tests #22–23)', () => {
  let db: TestPgDb | undefined;
  let boekhouding: Boekhouding | undefined;
  let boekjaarSvc: BoekjaarService | undefined;
  let afrekeningSvc: AfrekeningService | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    boekhouding = maakBoekhouding({ db: db.db });
    boekjaarSvc = maakBoekjaarService({ db: db.db });
    afrekeningSvc = maakAfrekeningService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  interface Opstelling {
    vveId: bigint;
    persoonId: bigint;
    jaarId: bigint;
    eenheden: { id: bigint; code: string }[];
    sleutelId: bigint;
  }

  /** Twee eenheden met gelijke breukdelen, open boekjaar 2026, vaste sleutel. */
  async function seed(): Promise<Opstelling> {
    if (!db || !boekjaarSvc) throw new Error('geen setup');
    teller += 1;
    const n = `${String(teller)}-${String(process.pid)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B09-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b09-${n}@test.vve`, achternaam: 'Beheer' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));

    const eenheden: { id: bigint; code: string }[] = [];
    for (const code of ['001', '002']) {
      const [e] = await db.db
        .insert(wooneenheid)
        .values({ vveId: v.id, code, breukdeelTeller: 500, breukdeelNoemer: 1000 })
        .returning({ id: wooneenheid.id });
      if (e === undefined) throw new Error('eenheid faalde');
      eenheden.push({ id: e.id, code });
    }

    const [sleutel] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Breukdeel', type: 'breukdeel' })
      .returning({ id: verdeelsleutel.id });
    if (sleutel === undefined) throw new Error('sleutel faalde');

    const { id } = await boekjaarSvc.maakBoekjaar(
      v.id,
      { jaar: 2026, startDatum: '2026-01-01', eindDatum: '2026-12-31' },
      p.id,
    );
    await boekjaarSvc.open(v.id, id, p.id);
    return { vveId: v.id, persoonId: p.id, jaarId: id, eenheden, sleutelId: sleutel.id };
  }

  /** Vastgestelde begroting die rekening 4100 aan de sleutel koppelt. */
  async function begrootOnderhoud(o: Opstelling, bedragCent: number): Promise<void> {
    if (!db) throw new Error('geen setup');
    const [rekening] = await db.db
      .select({ id: grootboekrekening.id })
      .from(grootboekrekening)
      .where(and(eq(grootboekrekening.vveId, o.vveId), eq(grootboekrekening.nummer, '4100')))
      .limit(1);
    if (rekening === undefined) throw new Error('rekening 4100 ontbreekt');
    const [b] = await db.db
      .insert(begroting)
      .values({ vveId: o.vveId, boekjaarId: o.jaarId, status: 'vastgesteld' })
      .returning({ id: begroting.id });
    if (b === undefined) throw new Error('begroting faalde');
    await db.db.insert(begrotingsregel).values({
      begrotingId: b.id,
      grootboekrekeningId: rekening.id,
      omschrijving: 'Onderhoud',
      bedragCent,
      verdeelsleutelId: o.sleutelId,
    });
  }

  /** Werkelijke onderhoudskosten boeken. */
  async function boekKosten(o: Opstelling, centen: number): Promise<void> {
    if (!boekhouding) throw new Error('geen setup');
    await boekhouding.boek(
      o.vveId,
      o.jaarId,
      {
        datum: '2026-06-01',
        omschrijving: 'Onderhoud lift',
        bron: 'memoriaal',
        regels: [
          Regel.debet('4100', Bedrag.vanCenten(centen)),
          Regel.credit('1100', Bedrag.vanCenten(centen)),
        ],
      },
      o.persoonId,
    );
  }

  /** Voorschotnota per eenheid. */
  async function notaVoor(
    o: Opstelling,
    eenheid: { id: bigint },
    persoonId: bigint,
    centen: number,
    volg: number,
  ): Promise<void> {
    if (!db) throw new Error('geen setup');
    await db.db.insert(nota).values({
      vveId: o.vveId,
      wooneenheidId: eenheid.id,
      persoonId,
      boekjaarId: o.jaarId,
      nummer: `2026-${String(volg).padStart(4, '0')}-${String(teller)}`,
      type: 'periodieke_bijdrage',
      factuurdatum: '2026-01-01',
      vervaldatum: '2026-01-31',
      bedragCent: centen,
      openstaandCent: centen,
      betalingskenmerk: `NOTA${String(volg)}${String(teller)}`,
    });
  }

  it('test #22: kosten min voorschotten per eenheid; de saldi tellen op tot het geheel', async () => {
    if (!db || !afrekeningSvc) throw new Error('geen setup');
    const o = await seed();
    await begrootOnderhoud(o, 100_000);
    await boekKosten(o, 120_000); // werkelijk duurder dan begroot
    const [e1, e2] = o.eenheden;
    if (e1 === undefined || e2 === undefined) throw new Error('geen eenheden');
    await notaVoor(o, e1, o.persoonId, 50_000, 1);
    await notaVoor(o, e2, o.persoonId, 50_000, 2);

    const uit = await afrekeningSvc.afrekening(o.vveId, o.jaarId);

    // Gelijke breukdelen: elk 60.000 kosten tegenover 50.000 voorschot.
    expect(uit.totaalKostenCent).toBe(120_000);
    expect(uit.totaalVoorschotCent).toBe(100_000);
    for (const e of uit.eenheden) {
      expect(e.kostenCent).toBe(60_000);
      expect(e.voorschotCent).toBe(50_000);
      expect(e.saldoCent).toBe(10_000);
    }

    // De kern van test #22: de som van de saldi is het tekort van het jaar.
    const som = uit.eenheden.reduce((s, e) => s + e.saldoCent, 0);
    expect(som).toBe(uit.totaalKostenCent - uit.totaalVoorschotCent);
    expect(som).toBe(20_000);
    expect(uit.totaalSaldoCent).toBe(som);
  });

  it('een overschot levert een negatief saldo op: terug te ontvangen', async () => {
    if (!afrekeningSvc) throw new Error('geen setup');
    const o = await seed();
    await begrootOnderhoud(o, 100_000);
    await boekKosten(o, 80_000);
    const [e1, e2] = o.eenheden;
    if (e1 === undefined || e2 === undefined) throw new Error('geen eenheden');
    await notaVoor(o, e1, o.persoonId, 50_000, 3);
    await notaVoor(o, e2, o.persoonId, 50_000, 4);

    const uit = await afrekeningSvc.afrekening(o.vveId, o.jaarId);
    for (const e of uit.eenheden) expect(e.saldoCent).toBe(-10_000);
    expect(uit.totaalSaldoCent).toBe(-20_000);
  });

  it('test #23: eigenaarswissel verdeelt pro rata over de dagen, delen tellen op', async () => {
    if (!db || !afrekeningSvc) throw new Error('geen setup');
    const o = await seed();
    await begrootOnderhoud(o, 100_000);
    await boekKosten(o, 120_000);
    const [e1, e2] = o.eenheden;
    if (e1 === undefined || e2 === undefined) throw new Error('geen eenheden');
    await notaVoor(o, e1, o.persoonId, 50_000, 5);
    await notaVoor(o, e2, o.persoonId, 50_000, 6);

    // Eenheid 001 wisselt op 1 juli van eigenaar.
    const [oud] = await db.db
      .insert(persoon)
      .values({ email: `b09-oud-${String(teller)}@test.vve`, achternaam: 'Oud' })
      .returning({ id: persoon.id });
    const [nieuw] = await db.db
      .insert(persoon)
      .values({ email: `b09-nieuw-${String(teller)}@test.vve`, achternaam: 'Nieuw' })
      .returning({ id: persoon.id });
    if (oud === undefined || nieuw === undefined) throw new Error('personen faalden');

    await db.db.insert(eigenaarschap).values({
      vveId: o.vveId,
      wooneenheidId: e1.id,
      persoonId: oud.id,
      periode: sql`daterange('2026-01-01','2026-07-01','[)')`,
    });
    await db.db.insert(eigenaarschap).values({
      vveId: o.vveId,
      wooneenheidId: e1.id,
      persoonId: nieuw.id,
      periode: sql`daterange('2026-07-01',NULL,'[)')`,
    });

    const uit = await afrekeningSvc.afrekening(o.vveId, o.jaarId);
    const eenheid = uit.eenheden.find((e) => e.code === '001');
    if (eenheid === undefined) throw new Error('eenheid 001 ontbreekt');

    expect(eenheid.saldoCent).toBe(10_000);
    expect(eenheid.delen).toHaveLength(2);

    // Handmatig: 1 jan t/m 30 juni = 181 dagen, 1 juli t/m 31 dec = 184 dagen.
    const [deelOud, deelNieuw] = eenheid.delen;
    if (deelOud === undefined || deelNieuw === undefined) throw new Error('delen ontbreken');
    expect(deelOud.dagen).toBe(181);
    expect(deelNieuw.dagen).toBe(184);
    expect(deelOud.dagen + deelNieuw.dagen).toBe(365);

    // 10.000 cent over 181/365 en 184/365 — grootste-restmethode, som exact.
    expect(deelOud.saldoCent + deelNieuw.saldoCent).toBe(eenheid.saldoCent);
    expect(deelOud.saldoCent).toBe(Math.round((10_000 * 181) / 365));
    expect(deelNieuw.naam).toBe('Nieuw');
  });

  it('dagenInclusief telt beide einddagen mee', () => {
    expect(dagenInclusief('2026-01-01', '2026-01-01')).toBe(1);
    expect(dagenInclusief('2026-01-01', '2026-06-30')).toBe(181);
    expect(dagenInclusief('2026-07-01', '2026-12-31')).toBe(184);
    // Een omgekeerd bereik levert nul dagen, geen negatief getal.
    expect(dagenInclusief('2026-12-31', '2026-01-01')).toBe(0);
  });

  it('een kostenpost zonder begrote sleutel wordt gemeld, niet overgeslagen', async () => {
    if (!afrekeningSvc) throw new Error('geen setup');
    const o = await seed();
    // Geen begroting: alle kosten vallen terug op de standaardsleutel.
    await boekKosten(o, 120_000);

    const uit = await afrekeningSvc.afrekening(o.vveId, o.jaarId);
    expect(uit.zonderEigenSleutel).toContain('4100');
    // En de kosten zijn wél verdeeld, niet verdwenen.
    expect(uit.totaalKostenCent).toBe(120_000);
    expect(uit.eenheden.reduce((s, e) => s + e.kostenCent, 0)).toBe(120_000);
  });
});
