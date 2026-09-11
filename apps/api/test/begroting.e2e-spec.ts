/**
 * Integratietest — begroting (G04, spec §6.5, M5 · AC5.1, AC5.7).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0016).
 * Controleert:
 *   - aanmaken met regels; totaalsplitsing exploitatie/reserve (§5.2);
 *   - statusflow concept → voorgesteld_alv → vastgesteld → gesloten, met
 *     weigering van ongeldige overgangen (AC5.1);
 *   - regels vervangen alleen in concept; vaststellen zet vastgesteld_op;
 *   - vorig-jaar-vergelijking: realisatie per rekening uit de boekingen
 *     van het vorige jaar (AC5.7-kolom);
 *   - dubbele begroting per boekjaar geweigerd; onbekende rekening geweigerd;
 *   - het boekjaar van een andere VvE is niet te gebruiken (tenant-scope).
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boeking,
  boekingsregel,
  boekjaar,
  grootboekrekening,
  persoon,
  verdeelsleutel,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import {
  maakBegrotingService,
  type BegrotingService,
} from '../src/financieel/begroting-service.js';
import { InvoerFout, NietGevondenFout } from '../src/financieel/boekhouding.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Begroting (G04, M5)', () => {
  let db: TestPgDb | undefined;
  let service: BegrotingService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakBegrotingService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /**
   * Seedt VvE + persoon + §5.7-schema + eenheid + twee boekjaren (vorig jaar
   * 2025 mét één boeking, dit jaar 2026 open) en een verdeelsleutel
   * (gelijke_delen; gewichten worden live gerekend).
   */
  async function seed(): Promise<{
    vveId: bigint;
    persoonId: bigint;
    jaarId: bigint;
    sleutelId: bigint;
  }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G04-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g04-${n}-${String(Date.now())}@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: 'A-01' })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid-seed faalde');

    const [vorig] = await db.db
      .insert(boekjaar)
      .values({
        vveId: v.id,
        jaar: 2025,
        startDatum: '2025-01-01',
        eindDatum: '2025-12-31',
        status: 'afgesloten',
      })
      .returning({ id: boekjaar.id });
    const [huidig] = await db.db
      .insert(boekjaar)
      .values({
        vveId: v.id,
        jaar: 2026,
        startDatum: '2026-01-01',
        eindDatum: '2026-12-31',
        status: 'open',
      })
      .returning({ id: boekjaar.id });
    if (vorig === undefined || huidig === undefined) throw new Error('jaar-seed faalde');

    // Realisatie vorig jaar (rechtstreeks geïnserte rijen; het jaar is al
    // afgesloten dus de boekingsservice weigert terecht — de realisatie
    // historie is er simpelweg). In balans: 2400 = 2400.
    const [boekingRij] = await db.db
      .insert(boeking)
      .values({
        vveId: v.id,
        boekjaarId: vorig.id,
        nummer: '2025-000001',
        datum: '2025-06-01',
        omschrijving: 'Schoonmaak juni 2025',
        bron: 'memoriaal',
        aangemaaktDoor: p.id,
      })
      .returning({ id: boeking.id });
    if (boekingRij === undefined) throw new Error('boeking-seed faalde');
    // De twee rekeningen expliciet opzoeken.
    const rekeningen = await db.db
      .select({ id: grootboekrekening.id, nummer: grootboekrekening.nummer })
      .from(grootboekrekening)
      .where(eq(grootboekrekening.vveId, v.id));
    const r4150 = rekeningen.find((r) => r.nummer === '4150');
    const r8100 = rekeningen.find((r) => r.nummer === '8100');
    if (r4150 === undefined || r8100 === undefined) throw new Error('rekeningen ontbreken');
    await db.db.insert(boekingsregel).values([
      {
        boekingId: boekingRij.id,
        grootboekrekeningId: r4150.id,
        omschrijving: 'Schoonmaak juni 2025',
        debetCent: 240_000,
        creditCent: 0,
      },
      {
        boekingId: boekingRij.id,
        grootboekrekeningId: r8100.id,
        omschrijving: null,
        debetCent: 0,
        creditCent: 240_000,
      },
    ]);

    // Verdeelsleutel: gelijke_delen (gewichten worden live gerekend).
    const [s] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Algemeen', type: 'gelijke_delen' })
      .returning({ id: verdeelsleutel.id });
    if (s === undefined) throw new Error('sleutel-seed faalde');

    return { vveId: v.id, persoonId: p.id, jaarId: huidig.id, sleutelId: s.id };
  }

  it('maakt een begroting met exploitatie/reserve-splitsing (§5.2)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, sleutelId } = await seed();
    await service.maak(
      vveId,
      jaarId,
      [
        {
          grootboekrekeningNummer: '4150',
          omschrijving: 'Schoonmaak',
          bedragCent: 6_000_00,
          verdeelsleutelId: sleutelId,
        },
        {
          grootboekrekeningNummer: '4950',
          omschrijving: 'Dotatie reservefonds',
          bedragCent: 2_400_00,
          verdeelsleutelId: sleutelId,
          isReservefonds: true,
        },
      ],
      persoonId,
    );
    const detail = await service.detail(vveId, jaarId);
    expect(detail.begroting.status).toBe('concept');
    expect(detail.totaalExploitatieCenten).toBe(6_000_00);
    expect(detail.totaalReservefondsCenten).toBe(2_400_00);
    expect(detail.regels).toHaveLength(2);
  });

  it('statusflow met vastgesteld_op; na vaststelling geen regels meer (AC5.1)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, sleutelId } = await seed();
    const { id } = await service.maak(
      vveId,
      jaarId,
      [
        {
          grootboekrekeningNummer: '4150',
          omschrijving: 'Schoonmaak',
          bedragCent: 1_00,
          verdeelsleutelId: sleutelId,
        },
      ],
      persoonId,
    );

    // Vaststellen vanuit concept is geweigerd (moet via voorgesteld_alv).
    await expect(service.zetStatus(vveId, id, 'vastgesteld', persoonId)).rejects.toThrow(
      InvoerFout,
    );
    await service.zetStatus(vveId, id, 'voorgesteld_alv', persoonId);
    await service.zetStatus(vveId, id, 'vastgesteld', persoonId);
    // Na vaststelling geen regels meer wijzigen — de ALV stemde op dit stuk.
    await expect(
      service.vervangRegels(
        vveId,
        id,
        [
          {
            grootboekrekeningNummer: '4150',
            omschrijving: 'Anders',
            bedragCent: 1,
            verdeelsleutelId: sleutelId,
          },
        ],
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);

    const detail = await service.detail(vveId, jaarId);
    expect(detail.begroting.status).toBe('vastgesteld');
    expect(detail.begroting.vastgesteldOp).not.toBeNull();
  });

  it('vorig-jaar-vergelijking toont realisatie per rekening (AC5.7-kolom)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, sleutelId } = await seed();
    await service.maak(
      vveId,
      jaarId,
      [
        {
          grootboekrekeningNummer: '4150',
          omschrijving: 'Schoonmaak',
          bedragCent: 3_600_00,
          verdeelsleutelId: sleutelId,
        },
        {
          grootboekrekeningNummer: '8100',
          omschrijving: 'Voorschotbijdragen',
          bedragCent: 3_600_00,
          verdeelsleutelId: sleutelId,
        },
      ],
      persoonId,
    );
    const detail = await service.detail(vveId, jaarId);
    const schoonmaak = detail.vergelijking.find((r) => r.rekeningNummer === '4150');
    const baten = detail.vergelijking.find((r) => r.rekeningNummer === '8100');
    // 4150 is last → debet-kant; 8100 is baat → credit-kant.
    expect(schoonmaak?.vorigJaarCenten).toBe(240_000);
    expect(schoonmaak?.begrotingCenten).toBe(3_600_00);
    expect(baten?.vorigJaarCenten).toBe(240_000);
    expect(baten?.begrotingCenten).toBe(3_600_00);
  });

  it('weigert een tweede begroting per boekjaar en een onbekende rekening', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, sleutelId } = await seed();
    const regels = [
      {
        grootboekrekeningNummer: '4150',
        omschrijving: 'Schoonmaak',
        bedragCent: 1_00,
        verdeelsleutelId: sleutelId,
      },
    ];
    await service.maak(vveId, jaarId, regels, persoonId);
    await expect(service.maak(vveId, jaarId, regels, persoonId)).rejects.toThrow(InvoerFout);

    const [tweeJaar] = await db.db
      .insert(boekjaar)
      .values({ vveId, jaar: 2027, startDatum: '2027-01-01', eindDatum: '2027-12-31' })
      .returning({ id: boekjaar.id });
    if (tweeJaar === undefined) throw new Error('jaar-seed 2 faalde');
    await expect(
      service.maak(
        vveId,
        tweeJaar.id,
        [
          {
            grootboekrekeningNummer: '9999',
            omschrijving: 'Bestaat niet',
            bedragCent: 1_00,
            verdeelsleutelId: sleutelId,
          },
        ],
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);
  });

  it('gesloten is niet bereikbaar vanuit concept (AC5.1-flow)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, sleutelId } = await seed();
    const { id } = await service.maak(
      vveId,
      jaarId,
      [
        {
          grootboekrekeningNummer: '4150',
          omschrijving: 'X',
          bedragCent: 1_00,
          verdeelsleutelId: sleutelId,
        },
      ],
      persoonId,
    );
    await expect(service.zetStatus(vveId, id, 'gesloten', persoonId)).rejects.toThrow(InvoerFout);
  });

  it('weigert een boekjaar van een andere VvE (tenant-scope)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { persoonId, jaarId } = await seed();
    const ander = await seed();
    const [sleutel] = await db.db
      .select({ id: verdeelsleutel.id })
      .from(verdeelsleutel)
      .where(eq(verdeelsleutel.vveId, ander.vveId))
      .limit(1);
    if (sleutel === undefined) throw new Error('sleutel ontbreekt');
    await expect(
      service.maak(
        ander.vveId,
        jaarId,
        [
          {
            grootboekrekeningNummer: '4150',
            omschrijving: 'X',
            bedragCent: 1_00,
            verdeelsleutelId: sleutel.id,
          },
        ],
        persoonId,
      ),
    ).rejects.toThrow(NietGevondenFout);
  });
});
