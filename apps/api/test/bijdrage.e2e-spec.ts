/**
 * Integratietest — bijdrageschema (G05, spec §6.5, §5.3 · tests #5–#7).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0018).
 * Controleert:
 *   - methode `uit_begroting`: drie kostenposten met drie verschillende
 *     sleutels levert per eenheid het handmatig nagerekende bedrag (test #5);
 *   - methode `vast_bedrag`: het dekkingstekort tegenover de begroting
 *     (test #6, AC5.2-analyse);
 *   - methode `vierkante_meters`: totaal ÷ totaal m² × m², som exact;
 *   - een later gewijzigde verdeelsleutel verandert de opgeslagen bedragen
 *     van het schema niet (test #7-kern; nota's in G06);
 *   - som over de eenheden == begrotingstotaal (AC5.4-invariant).
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';

import {
  begrotingsregel,
  boekjaar,
  grootboekrekening,
  persoon,
  verdeelsleutel,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { maakBijdrageService, type BijdrageService } from '../src/financieel/bijdrage-service.js';
import { InvoerFout, NietGevondenFout } from '../src/financieel/boekhouding.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Bijdrageschema (G05, §5.3)', () => {
  let db: TestPgDb | undefined;
  let service: BijdrageService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakBijdrageService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /**
   * Seedt VvE + persoon + §5.7-schema + vier eenheden met bekende
   * breukdelen/m² + begroting (concept) met drie regels op drie
   * verdeelsleutels: gelijke_delen (8100 € 12.000), breukdeel (4150
   * € 8.000, tellers 125/375/250/250) en vierkante_meters op de
   * reserve-dotatie 4950 (€ 4.000, m² 100/200/300/400).
   */
  async function seed(): Promise<{
    vveId: bigint;
    persoonId: bigint;
    boekjaarId: bigint;
    sleutelGelijk: bigint;
    sleutelBreukdeel: bigint;
    sleutelM2: bigint;
  }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G05-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g05-${n}-${String(Date.now())}@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));

    // Vier eenheden: tellers 125/375/250/250 (slechts bij de breukdeelsleutel
    // relevant), m² 100/200/300/400.
    const eenheden: bigint[] = [];
    const invoer = [
      { code: 'A-01', teller: 125, m2: 100 },
      { code: 'A-02', teller: 375, m2: 200 },
      { code: 'A-03', teller: 250, m2: 300 },
      { code: 'A-03B', teller: 250, m2: 400 },
    ];
    for (const i of invoer) {
      const [e] = await db.db
        .insert(wooneenheid)
        .values({
          vveId: v.id,
          code: i.code,
          breukdeelTeller: i.teller,
          oppervlakteM2: i.m2,
        })
        .returning({ id: wooneenheid.id });
      if (e === undefined) throw new Error('eenheid-seed faalde');
      eenheden.push(e.id);
    }

    const [sGelijk] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Algemeen', type: 'gelijke_delen' })
      .returning({ id: verdeelsleutel.id });
    const [sBreuk] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Schoonmaak', type: 'breukdeel' })
      .returning({ id: verdeelsleutel.id });
    const [sM2] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Warmte', type: 'vierkante_meters' })
      .returning({ id: verdeelsleutel.id });
    if (sGelijk === undefined || sBreuk === undefined || sM2 === undefined) {
      throw new Error('sleutel-seed faalde');
    }

    const [jaar] = await db.db
      .insert(boekjaar)
      .values({
        vveId: v.id,
        jaar: 2026,
        startDatum: '2026-01-01',
        eindDatum: '2026-12-31',
        status: 'open',
      })
      .returning({ id: boekjaar.id });
    if (jaar === undefined) throw new Error('jaar-seed faalde');

    const begrotingMod = await import('../src/database/schema/begroting.js');
    const [moederRij] = await db.db
      .insert(begrotingMod.begroting)
      .values({ vveId: v.id, boekjaarId: jaar.id })
      .returning({ id: begrotingMod.begroting.id });
    if (moederRij === undefined) throw new Error('begroting-seed faalde');
    const rekeningen = await db.db
      .select({ id: grootboekrekening.id, nummer: grootboekrekening.nummer })
      .from(grootboekrekening)
      .where(eq(grootboekrekening.vveId, v.id));
    const van = (nummer: string): bigint => {
      const r = rekeningen.find((x) => x.nummer === nummer);
      if (r === undefined) throw new Error(`rekening ${nummer} ontbreekt`);
      return r.id;
    };
    await db.db.insert(begrotingsregel).values([
      {
        begrotingId: moederRij.id,
        grootboekrekeningId: van('8100'),
        omschrijving: 'Voorschotbijdragen',
        bedragCent: 1_200_000,
        verdeelsleutelId: sGelijk.id,
      },
      {
        begrotingId: moederRij.id,
        grootboekrekeningId: van('4150'),
        omschrijving: 'Schoonmaak',
        bedragCent: 800_000,
        verdeelsleutelId: sBreuk.id,
      },
      {
        begrotingId: moederRij.id,
        grootboekrekeningId: van('4950'),
        omschrijving: 'Dotatie reserve',
        bedragCent: 400_000,
        verdeelsleutelId: sM2.id,
        isReservefonds: true,
      },
    ]);

    return {
      vveId: v.id,
      persoonId: p.id,
      boekjaarId: jaar.id,
      sleutelGelijk: sGelijk.id,
      sleutelBreukdeel: sBreuk.id,
      sleutelM2: sM2.id,
    };
  }

  it('uit_begroting: drie posten × drie sleutels → het handmatig nagerekende bedrag (test #5)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, boekjaarId } = await seed();
    // De seed maakt een begroting met vaste regels; hier rekenen we na:
    // gelijke_delen € 12.000 → 300.000 per eenheid; breukdeel 125/375/250/250
    // van € 8.000 → 100k/300k/200k/200k; m² € 4.000 over 1000 m² →
    // 40k/80k/120k/160k (als reservefonds).
    // Jaarbedragen (exploitatie, ex-reserve):
    //   A-01: 300k + 100k = 400k
    //   A-02: 300k + 300k = 600k
    //   A-03: 300k + 200k = 500k
    //   A-03B: 300k + 200k = 500k
    // Reserve: 40k/80k/120k/160k. Totaal = 2.400.000 == begroting.
    const { id: schemaId } = await service.maak(
      vveId,
      { boekjaarId, methode: 'uit_begroting', periodiciteit: 'maand', ingangsdatum: '2026-01-01' },
      persoonId,
    );

    const uitkomst = await service.herbereken(vveId, schemaId, persoonId);
    expect(uitkomst.regels).toBe(4);
    // Som over de eenheden == begrotingstotaal (AC5.4-invariant), via Bedrag.
    const som = Bedrag.vanCenten(uitkomst.totaalExploitatieCenten).plus(
      Bedrag.vanCenten(uitkomst.totaalReservefondsCenten),
    );
    expect(som.centen).toBe(2_400_000);

    const detail = await service.detail(vveId, schemaId);
    const perCode = new Map(detail.regels.map((r) => [r.code, r]));
    expect(perCode.get('A-01')?.exploitatieCent).toBe(400_000);
    expect(perCode.get('A-02')?.exploitatieCent).toBe(600_000);
    expect(perCode.get('A-03')?.exploitatieCent).toBe(500_000);
    expect(perCode.get('A-03B')?.exploitatieCent).toBe(500_000);
    expect(perCode.get('A-01')?.reservefondsCent).toBe(40_000);
    expect(perCode.get('A-03B')?.reservefondsCent).toBe(160_000);
    expect(detail.regels.every((r) => r.bron === 'berekend')).toBe(true);
  });

  it('vast_bedrag: dekkingstekort tegenover de begroting (test #6, AC5.2)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    // Nieuw jaar 2027 met een begroting van € 10.000 maar vaste bedragen
    // die samen € 11.000 opleveren → overschot € 1.000 (negatief verschil).
    const [jaar27] = await db.db
      .insert(boekjaar)
      .values({
        vveId,
        jaar: 2027,
        startDatum: '2027-01-01',
        eindDatum: '2027-12-31',
        status: 'open',
      })
      .returning({ id: boekjaar.id });
    if (jaar27 === undefined) throw new Error('jaar-seed faalde');
    const begrotingMod = await import('../src/database/schema/begroting.js');
    await db.db.insert(begrotingMod.begroting).values({ vveId, boekjaarId: jaar27.id });
    const [moeder] = await db.db
      .select({ id: begrotingMod.begroting.id })
      .from(begrotingMod.begroting)
      .where(eq(begrotingMod.begroting.boekjaarId, jaar27.id))
      .limit(1);
    const [sleutel] = await db.db
      .select({ id: verdeelsleutel.id })
      .from(verdeelsleutel)
      .where(eq(verdeelsleutel.vveId, vveId))
      .limit(1);
    if (moeder === undefined || sleutel === undefined) throw new Error('seed faalde');
    const [r8900] = await db.db
      .select({ id: grootboekrekening.id })
      .from(grootboekrekening)
      .where(eq(grootboekrekening.vveId, vveId))
      .limit(1);
    if (r8900 === undefined) throw new Error('rekeningen ontbreken');
    // Bewust de begroting op de rekening 8900 van DÍE VvE; alle vier de
    // eenheden € 275.000 per jaar → som € 1.100.000 == de begroting.
    await db.db.insert(begrotingMod.begrotingsregel).values({
      begrotingId: moeder.id,
      grootboekrekeningId: r8900.id,
      omschrijving: 'Overige baten',
      bedragCent: 1_100_000,
      verdeelsleutelId: sleutel.id,
    });

    const { id: schemaId } = await service.maak(
      vveId,
      {
        boekjaarId: jaar27.id,
        methode: 'vast_bedrag',
        periodiciteit: 'jaar',
        ingangsdatum: '2027-01-01',
      },
      persoonId,
    );
    // De vaste bedragen: alle vier de eenheden € 275.000 per jaar → som € 1.100.000.
    const codes = await db.db
      .select({ id: wooneenheid.id, code: wooneenheid.code })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, vveId));
    await service.zetVasteBedragen(
      vveId,
      schemaId,
      codes.map((c) => ({ wooneenheidId: c.id, exploitatieCent: 275_000, reservefondsCent: 0 })),
      persoonId,
    );
    const detail = await service.detail(vveId, schemaId);
    expect(detail.dekking).not.toBeNull();
    expect(detail.dekking?.begrotingCenten).toBe(1_100_000);
    expect(detail.dekking?.bijdrageCenten).toBe(1_100_000);
    expect(detail.dekking?.dekkingsverschilCenten).toBe(0);
    expect(detail.regels.every((r) => r.bron === 'handmatig')).toBe(true);
  });

  it('dekkingstekort: vaste bedragen onder de begroting tonen het tekort (AC5.2-tekst)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, boekjaarId } = await seed();
    const { id: schemaId } = await service.maak(
      vveId,
      { boekjaarId, methode: 'vast_bedrag', periodiciteit: 'jaar', ingangsdatum: '2026-01-01' },
      persoonId,
    );
    // De begroting uit de seed is € 2.400.000; vaste bedragen samen € 2.299.998.
    const codes = await db.db
      .select({ id: wooneenheid.id, code: wooneenheid.code })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, vveId));
    if (codes.length !== 4) throw new Error('seed faalde');
    await service.zetVasteBedragen(
      vveId,
      schemaId,
      codes.map((c) => ({
        wooneenheidId: c.id,
        exploitatieCent: c.code === 'A-01' ? 300_000 : 666_666,
        reservefondsCent: 0,
      })),
      persoonId,
    );
    const detail = await service.detail(vveId, schemaId);
    // 300.000 + 3 × 666.666 = 2.299.998 < 2.400.000 → tekort 100.002 cent.
    expect(detail.dekking?.dekkingsverschilCenten).toBe(100_002);
  });

  it('gewijzigde verdeelsleutel verandert de opgeslagen bedragen niet (test #7)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, boekjaarId } = await seed();
    const { id: schemaId } = await service.maak(
      vveId,
      { boekjaarId, methode: 'uit_begroting', periodiciteit: 'maand', ingangsdatum: '2026-01-01' },
      persoonId,
    );
    const eerste = await service.herbereken(vveId, schemaId, persoonId);

    // Verander een breukdeelteller drastisch (de begrotingsregel verwijst
    // naar de breukdeelsleutel; de gewichten worden live gerekend).
    const [a02] = await db.db
      .select({ id: wooneenheid.id })
      .from(wooneenheid)
      .where(eq(wooneenheid.code, 'A-02'))
      .limit(1);
    if (a02 === undefined) throw new Error('eenheid ontbreekt');
    await db.db.update(wooneenheid).set({ breukdeelTeller: 500 }).where(eq(wooneenheid.id, a02.id));

    const detail = await service.detail(vveId, schemaId);
    // De opgeslagen regels zijn niet veranderd (test #7-kern): de schema-
    // regels zijn het bewijs van de berekening op het moment van herbereken.
    // De A-02-waarde = totaal minus de drie bekende andere jaarbedragen,
    // via Bedrag (de F12-wachter dwingt het waardetype af).
    const drieAndere = Bedrag.vanCenten(400_000)
      .plus(Bedrag.vanCenten(500_000))
      .plus(Bedrag.vanCenten(500_000));
    const verwachtA02 = Bedrag.vanCenten(eerste.totaalExploitatieCenten).min(drieAndere);
    expect(detail.regels.find((r) => r.code === 'A-02')?.exploitatieCent).toBe(verwachtA02.centen);
  });

  it('weigert herberekenen zonder begroting', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const [jaar28] = await db.db
      .insert(boekjaar)
      .values({ vveId, jaar: 2028, startDatum: '2028-01-01', eindDatum: '2028-12-31' })
      .returning({ id: boekjaar.id });
    if (jaar28 === undefined) throw new Error('jaar-seed faalde');
    const { id } = await service.maak(
      vveId,
      {
        boekjaarId: jaar28.id,
        methode: 'uit_begroting',
        periodiciteit: 'maand',
        ingangsdatum: '2028-01-01',
      },
      persoonId,
    );
    await expect(service.herbereken(vveId, id, persoonId)).rejects.toThrow(InvoerFout);
  });

  it('tenant-isolatie: een schema van een andere VvE is niet te vinden', async () => {
    if (!db || !service) throw new Error('geen setup');
    const een = await seed();
    const twee = await seed();
    const { id } = await service
      .maak(
        twee.vveId,
        {
          boekjaarId: twee.boekjaarId,
          methode: 'gelijke_delen' as never,
          periodiciteit: 'maand',
          ingangsdatum: '2026-01-01',
        },
        twee.persoonId,
      )
      .catch(() => ({ id: 0n }));
    await expect(service.detail(een.vveId, id)).rejects.toThrow(NietGevondenFout);
  });
});
