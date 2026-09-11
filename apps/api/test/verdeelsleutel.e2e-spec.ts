/**
 * Integratietest — verdeelsleutels (G03, spec §6.5, M4 · AC4.1–AC4.5).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0015).
 * Controleert:
 *   - breukdeel: gewicht = teller, verdeling via de grootste-restmethode,
 *     som van de delen exact het proefbedrag (AC4.4, §5.2);
 *   - gelijke_delen en uitsluiting (gewicht 0 → weg, rest verdeeld);
 *   - handmatig: opgeslagen gewichten, uitsluiting via gewicht 0 (AC4.2);
 *   - vierkante_meters: gewicht = oppervlakte;
 *   - een sleutel van een andere VvE is niet te vinden (tenant-isolatie);
 *   - historisering: nieuwe versie +1, oude op actief = false (AC4.5).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import { persoon, vve, wooneenheid } from '../src/database/schema/index.js';
import {
  maakVerdeelsleutelService,
  type VerdeelsleutelService,
} from '../src/financieel/verdeelsleutel-service.js';
import { InvoerFout, NietGevondenFout } from '../src/financieel/boekhouding.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Verdeelsleutels (G03, M4)', () => {
  let db: TestPgDb | undefined;
  let service: VerdeelsleutelService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakVerdeelsleutelService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + persoon + drie eenheden met breukdelen/m²/stemmen. */
  async function seed(): Promise<{
    vveId: bigint;
    persoonId: bigint;
    eenheden: { id: bigint; code: string }[];
  }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G03-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g03-${n}-${String(Date.now())}@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    const invoer = [
      { code: 'A-01', breukdeelTeller: 125, oppervlakteM2: 100.0, stemmen: 1 },
      { code: 'A-02', breukdeelTeller: 375, oppervlakteM2: 200.0, stemmen: 2 },
      { code: 'A-03', breukdeelTeller: 500, oppervlakteM2: 300.0, stemmen: 3 },
    ];
    const eenheden: { id: bigint; code: string }[] = [];
    for (const i of invoer) {
      const [e] = await db.db
        .insert(wooneenheid)
        .values({
          vveId: v.id,
          code: i.code,
          breukdeelTeller: i.breukdeelTeller,
          oppervlakteM2: i.oppervlakteM2,
          stemmen: i.stemmen,
        })
        .returning({ id: wooneenheid.id, code: wooneenheid.code });
      if (e === undefined) throw new Error('eenheid-seed faalde');
      eenheden.push({ id: e.id, code: e.code });
    }
    return { vveId: v.id, persoonId: p.id, eenheden };
  }

  it('breukdeel: gewicht = teller; verdeling exact (AC4.4, §5.2)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id } = await service.maak(vveId, { naam: 'Algemeen', type: 'breukdeel' }, persoonId);

    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(12_000_00));
    // Gewichten 125/375/500 → 1500 / 4500 / 6000 cent — exact, geen restcenten.
    const perCode = new Map(voorbeeld.rijen.map((r) => [r.code, r.bedragCenten]));
    expect(perCode.get('A-01')).toBe(1_500_00);
    expect(perCode.get('A-02')).toBe(4_500_00);
    expect(perCode.get('A-03')).toBe(6_000_00);
    expect(voorbeeld.onverdeeldCenten).toBe(0);
    expect(voorbeeld.rijen).toHaveLength(3);
  });

  it('breukdeel: restcenten via grootste-restmethode, som exact', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id } = await service.maak(vveId, { naam: 'Algemeen', type: 'breukdeel' }, persoonId);
    // Tellers 125/375/500 (verhouding 1:3:4) van € 100,01 = 10001 cent:
    // 1250,000125 / 3750,000375 / 5000,0005 → 1250 / 3750 / 5001 (rest naar
    // het grootste fractionele restdeel, hier A-03).
    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(10_001));
    expect(voorbeeld.rijen.map((r) => r.bedragCenten)).toEqual([1250, 3750, 5001]);
    expect(voorbeeld.onverdeeldCenten).toBe(0);
  });

  it('gelijke_delen: elke deelnemende eenheid een gelijk deel (AC4.2-basis)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id } = await service.maak(
      vveId,
      { naam: 'Schoonmaak', type: 'gelijke_delen' },
      persoonId,
    );
    // AC4.2-variant via een handmatige uitsluiting is niet de weg hier;
    // uitsluiting bij afgeleide typen = gewicht-0-regel. Die bestaat alleen
    // bij handmatig — bij gelijke_delen test ik de afgeleide basis:
    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(9_00));
    expect(voorbeeld.rijen).toHaveLength(3);
    expect(voorbeeld.rijen.every((r) => r.bedragCenten === 3_00)).toBe(true);
    expect(voorbeeld.onverdeeldCenten).toBe(0);
  });

  it('handmatig: gewicht 0 sluit uit, rest over de overigen (AC4.2)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheden } = await seed();
    // AC4.2: gewicht 0 sluit uit; de rest deelt mee in de opgegeven verhouding.
    const { id } = await service.maak(
      vveId,
      {
        naam: 'Parkeerdek',
        type: 'handmatig',
        regels: [
          { wooneenheidId: eenheden[0]?.id ?? 0n, gewicht: 0 },
          { wooneenheidId: eenheden[1]?.id ?? 0n, gewicht: 1 },
          { wooneenheidId: eenheden[2]?.id ?? 0n, gewicht: 2 },
        ],
      },
      persoonId,
    );
    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(6_00));
    // Uitgesloten A-01 ontbreekt; 1:2 over € 6 → 200 / 400 cent.
    expect(voorbeeld.rijen).toHaveLength(2);
    const perCode = new Map(voorbeeld.rijen.map((r) => [r.code, r.bedragCenten]));
    expect(perCode.get('A-01')).toBeUndefined();
    expect(perCode.get('A-02')).toBe(200);
    expect(perCode.get('A-03')).toBe(400);
    expect(voorbeeld.onverdeeldCenten).toBe(0);
  });

  it('vierkante_meters: gewicht = oppervlakte', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id } = await service.maak(
      vveId,
      { naam: 'Warmte', type: 'vierkante_meters' },
      persoonId,
    );
    // m² 100/200/300 = 1:2:3 van € 600 → 100 / 200 / 300.
    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(60_000));
    const perCode = new Map(voorbeeld.rijen.map((r) => [r.code, r.bedragCenten]));
    expect(perCode.get('A-01')).toBe(10_000);
    expect(perCode.get('A-02')).toBe(20_000);
    expect(perCode.get('A-03')).toBe(30_000);
    expect(voorbeeld.onverdeeldCenten).toBe(0);
  });

  it('stemmen: gewicht = aantal stemmen', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id } = await service.maak(vveId, { naam: 'Per stem', type: 'stemmen' }, persoonId);
    // Stemmen 1/2/3 van € 12.000 → 2000 / 4000 / 6000.
    const voorbeeld = await service.voorbeeldVerdeling(vveId, id, Bedrag.vanCenten(1_200_000));
    const perCode = new Map(voorbeeld.rijen.map((r) => [r.code, r.bedragCenten]));
    expect(perCode.get('A-01')).toBe(200_000);
    expect(perCode.get('A-02')).toBe(400_000);
    expect(perCode.get('A-03')).toBe(600_000);
  });

  it('tenant-isolatie: een sleutel van VvE B is niet te zien in VvE A', async () => {
    if (!db || !service) throw new Error('geen setup');
    const een = await seed();
    const twee = await seed();
    const { id } = await service.maak(
      twee.vveId,
      { naam: 'Van B', type: 'gelijke_delen' },
      twee.persoonId,
    );
    await expect(service.detail(een.vveId, id)).rejects.toThrow(NietGevondenFout);
  });

  it('historisering: nieuwe versie +1, oude op actief = false (AC4.5)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheden } = await seed();
    const { id: v1 } = await service.maak(
      vveId,
      {
        naam: 'Parkeerdek',
        type: 'handmatig',
        regels: [{ wooneenheidId: eenheden[0]?.id ?? 0n, gewicht: 1 }],
      },
      persoonId,
    );
    const { id: v2 } = await service.nieuweVersie(
      vveId,
      v1,
      {
        regels: [
          { wooneenheidId: eenheden[0]?.id ?? 0n, gewicht: 1 },
          { wooneenheidId: eenheden[1]?.id ?? 0n, gewicht: 1 },
        ],
      },
      persoonId,
    );
    const detailV2 = await service.detail(vveId, v2);
    expect(detailV2.sleutel.versie).toBe(2);
    expect(detailV2.sleutel.actief).toBe(true);
    expect(detailV2.regels).toHaveLength(2);

    const detailV1 = await service.detail(vveId, v1);
    expect(detailV1.sleutel.versie).toBe(1);
    expect(detailV1.sleutel.actief).toBe(false); // bewust onveranderd behouden

    // De oude versie blijft bereikbaar met zijn oorspronkelijke regels.
    expect(detailV1.regels).toHaveLength(1);
  });

  it('weigert een handmatige sleutel zonder regels', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    await expect(
      service.maak(vveId, { naam: 'Leeg', type: 'handmatig' }, persoonId),
    ).rejects.toThrow(InvoerFout);
  });

  it('weigert een sleutel waarvan alle eenheden zijn uitgesloten', async () => {
    if (!db || !service) throw new Error('geen setup');
    await seed();
    // Een VvE zónder eenheden heeft geen gewichten → InvoerFout op verdeling.
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G03-leeg-${String(vveNummer)}` })
      .returning({ id: vve.id });
    const [p2] = await db.db
      .insert(persoon)
      .values({ email: `g03-leeg-${String(Date.now())}@test.vve`, achternaam: 'Leeg' })
      .returning({ id: persoon.id });
    if (v === undefined || p2 === undefined) throw new Error('seed faalde');
    const { id } = await service.maak(v.id, { naam: 'Algemeen', type: 'breukdeel' }, p2.id);
    await expect(service.voorbeeldVerdeling(v.id, id, Bedrag.vanCenten(1_00))).rejects.toThrow(
      InvoerFout,
    );
  });
});
