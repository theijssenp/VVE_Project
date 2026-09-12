/**
 * Integratietest — eigenaarschap (V03, spec M2 · AC2.4/AC2.5, test 34).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0024, dus
 * `eigenaarschap` bestaat met de daterange-EXCLUDE-constraints uit 0010).
 * Controleert:
 *   - test #34: twee gelijktijdige aandelen 600+600 wordt geweigerd,
 *     500+500 wordt toegestaan; een tweede volledig eigendom in dezelfde
 *     periode wordt door de exclusion constraint geweigerd;
 *   - AC2.4: tweede eigenaar met aandeel, primair contact overzetten;
 *   - AC2.5: de eigenaarswissel op de leveringsdatum — oud eindigt op
 *     leveringsdatum − 1, nieuw begint op de leveringsdatum; historische
 *     nota's blijven aan de oude eigenaar;
 *   - het verrekenoverzicht: de som van de rijbedragen is exact het
 *     jaartotaal en de verdeling volgt de dagen-verhouding (rato);
 *   - openstaande posten van de verkoper worden gesignaleerd.
 *
 * De service roept `inTenantTransactie` aan; de tests draaien op de
 * superuser-pool van de testcontainer — `SET LOCAL app.vve_id` bepaalt wat
 * de RLS-policies zien, exact zoals de RLS-suite (F04) dat bewijst.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';

import { boekjaar } from '../src/database/schema/boekjaar.js';
import { eigenaarschap, nota, persoon, vve, wooneenheid } from '../src/database/schema/index.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import {
  maakEigenaarschapService,
  type EigenaarschapService,
} from '../src/financieel/eigenaarschap-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Eigenaarschap (V03, AC2.4–2.5, test 34)', () => {
  let db: TestPgDb | undefined;
  let service: EigenaarschapService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakEigenaarschapService({ db: db.db, klok: new SystemKlok() });
  });

  afterAll(async () => {
    await db?.stop();
  });

  interface Seed {
    readonly vveId: bigint;
    readonly beheerderId: bigint;
    readonly eigenaarA: bigint;
    readonly eigenaarB: bigint;
    readonly eenheidId: bigint;
  }

  /**
   * Seedt een VvE + beheerder + twee personen + één eenheid, met persoon A
   * als lopend (primair) eigenaar op 1000 promille sinds 2026-01-01. Elke
   * seed krijgt een eigen VvE — de gedeelde testcontainer bevat de rijen van
   * élke eerdere suite, dus alle lookups blijven met vve_id gescopeid.
   */
  async function seed(): Promise<Seed> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const uniek = `${n}-${String(Date.now())}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `V03-VvE-${n}` })
      .returning({ id: vve.id });
    const [beheerder] = await db.db
      .insert(persoon)
      .values({ email: `v03-${uniek}-b@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    const [a] = await db.db
      .insert(persoon)
      .values({ email: `v03-${uniek}-a@test.vve`, achternaam: 'Verkoper' })
      .returning({ id: persoon.id });
    const [b] = await db.db
      .insert(persoon)
      .values({ email: `v03-${uniek}-c@test.vve`, achternaam: 'Koper' })
      .returning({ id: persoon.id });
    if (v === undefined || beheerder === undefined || a === undefined || b === undefined) {
      throw new Error('seed faalde');
    }
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: 'A-01', oppervlakteM2: 100 })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid-seed faalde');
    await db.db.insert(eigenaarschap).values({
      vveId: v.id,
      wooneenheidId: e.id,
      persoonId: a.id,
      aandeelPromille: 1000,
      isPrimairContact: true,
      periode: '[2026-01-01,)',
    });
    return {
      vveId: v.id,
      beheerderId: beheerder.id,
      eigenaarA: a.id,
      eigenaarB: b.id,
      eenheidId: e.id,
    };
  }

  /** Verlaagt de seed-eigenaarschapsrij naar het opgegeven aandeel. */
  async function zetAandeel(s: Seed, promille: number): Promise<void> {
    if (!db) throw new Error('geen test-db');
    await db.db
      .update(eigenaarschap)
      .set({ aandeelPromille: promille })
      .where(
        and(
          eq(eigenaarschap.vveId, s.vveId),
          eq(eigenaarschap.wooneenheidId, s.eenheidId),
          eq(eigenaarschap.persoonId, s.eigenaarA),
        ),
      );
  }

  /** Seedt een open boekjaar + nota's voor de eenheid; geeft het boekjaar-id. */
  async function seedNotas(
    s: Seed,
    jaar: number,
    notarijen: readonly { kenmerkSufix: string; factuurdatum: string; centen: number }[],
  ): Promise<bigint> {
    if (!db) throw new Error('geen test-db');
    const jaarS = String(jaar);
    await db.db.insert(boekjaar).values({
      vveId: s.vveId,
      jaar,
      startDatum: `${jaarS}-01-01`,
      eindDatum: `${jaarS}-12-31`,
    });
    const [j] = await db.db
      .select({ id: boekjaar.id })
      .from(boekjaar)
      .where(and(eq(boekjaar.vveId, s.vveId), eq(boekjaar.jaar, jaar)))
      .limit(1);
    if (j === undefined) throw new Error('boekjaar-seed faalde');
    const kenmerkbasis = `NOTAV03${jaarS}${String(s.vveId)}`;
    if (notarijen.length > 0) {
      await db.db.insert(nota).values(
        notarijen.map((n, i) => ({
          vveId: s.vveId,
          wooneenheidId: s.eenheidId,
          persoonId: s.eigenaarA,
          boekjaarId: j.id,
          nummer: `NOTA-V03-${jaarS}-${String(s.vveId)}-${String(i)}`,
          type: 'periodieke_bijdrage' as const,
          factuurdatum: n.factuurdatum,
          vervaldatum: n.factuurdatum,
          bedragCent: n.centen,
          openstaandCent: n.centen,
          betalingskenmerk: `${kenmerkbasis}${n.kenmerkSufix}`,
          status: 'open' as const,
        })),
      );
    }
    return j.id;
  }

  it('test 34 — 600+600 geweigerd, 500+500 toegestaan, tweede volledig eigendom geweigerd', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    // De seed-eigenaar zit op 1000 promille: een tweede van 600 brengt de
    // som op 1600 — de somtoets weigert vóór er ook maar iets staat.
    await expect(
      service.voegEigenaarToe(
        s.vveId,
        s.eenheidId,
        { persoonId: s.eigenaarB, aandeelPromille: 600, isPrimairContact: false },
        s.beheerderId,
      ),
    ).rejects.toThrow(/maximaal 1000/);

    // Tweede volledig eigendom (de EXCLUDE-bewaking van de migratie): de
    // seed-eigenaar zit nog op 1000 — een directe insert van een derde
    // persoon op 1000 in dezelfde periode botst op
    // `geen_dubbel_volledig_eigendom` (23P01), langs de service heen.
    const [c] = await db.db
      .insert(persoon)
      .values({
        email: `v03-${nVan(s.vveId)}-d-${String(Date.now())}@test.vve`,
        achternaam: 'Derde',
      })
      .returning({ id: persoon.id });
    if (c === undefined) throw new Error('derde-persoon-seed faalde');
    await expect(
      db.db.insert(eigenaarschap).values({
        vveId: s.vveId,
        wooneenheidId: s.eenheidId,
        persoonId: c.id,
        aandeelPromille: 1000,
        isPrimairContact: false,
        periode: '[2026-01-01,)',
      }),
    ).rejects.toThrow(); // exclusion constraint (23P01)

    // Bestaande eigenaar terug naar 600, dan een tweede van 600: nog steeds
    // boven de som (1200) — geweigerd (de letter van test 34).
    await zetAandeel(s, 600);
    await expect(
      service.voegEigenaarToe(
        s.vveId,
        s.eenheidId,
        { persoonId: s.eigenaarB, aandeelPromille: 600, isPrimairContact: false },
        s.beheerderId,
      ),
    ).rejects.toThrow(/maximaal 1000/);

    // 500+500 wordt toegestaan (AC2.4).
    await zetAandeel(s, 500);
    await service.voegEigenaarToe(
      s.vveId,
      s.eenheidId,
      { persoonId: s.eigenaarB, aandeelPromille: 500, isPrimairContact: false },
      s.beheerderId,
    );
    const rijen = await service.eigenaren(s.vveId, s.eenheidId);
    expect(rijen).toHaveLength(2);
    const a = rijen.find((r) => r.persoonId === s.eigenaarA);
    const b = rijen.find((r) => r.persoonId === s.eigenaarB);
    expect(a?.aandeelPromille).toBe(500);
    expect(b?.aandeelPromille).toBe(500);
    expect(a?.isPrimairContact).toBe(true);
    expect(b?.isPrimairContact).toBe(false);
  });

  it('AC2.4 — primair contact overzetten naar de tweede eigenaar', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    // Split: 500/500, dan het primaire contact overzetten naar B.
    await zetAandeel(s, 500);
    const { id } = await service.voegEigenaarToe(
      s.vveId,
      s.eenheidId,
      { persoonId: s.eigenaarB, aandeelPromille: 500, isPrimairContact: false },
      s.beheerderId,
    );
    await service.zetPrimairContact(s.vveId, s.eenheidId, id, s.beheerderId);

    const rijen = await service.eigenaren(s.vveId, s.eenheidId);
    const a = rijen.find((r) => r.persoonId === s.eigenaarA);
    const b = rijen.find((r) => r.persoonId === s.eigenaarB);
    expect(a?.isPrimairContact).toBe(false);
    expect(b?.isPrimairContact).toBe(true);
  });

  it('AC2.5 — wissel op leveringsdatum: oud eindigt levering−1, nieuw begint op levering', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const leveringsdatum = '2027-04-01';

    const { oudId, nieuwId } = await service.wisselEigenaar(
      s.vveId,
      s.eenheidId,
      { nieuwePersoonId: s.eigenaarB, leveringsdatum },
      s.beheerderId,
    );
    expect(oudId).toBeGreaterThan(0n);
    expect(nieuwId).toBeGreaterThan(0n);

    const rijen = await service.eigenaren(s.vveId, s.eenheidId);
    const oud = rijen.find((r) => r.eigenaarschapId === oudId);
    const nieuw = rijen.find((r) => r.eigenaarschapId === nieuwId);
    expect(oud?.totEnMet).toBe('2027-03-31'); // leveringsdatum − 1
    expect(oud?.vanaf).toBe('2026-01-01');
    expect(nieuw?.vanaf).toBe('2027-04-01');
    expect(nieuw?.totEnMet).toBeNull();
    expect(nieuw?.isPrimairContact).toBe(true); // het contact gaat mee

    // Een wissel op dezelfde leveringsdatum naar de verkoper zelf is een
    // niets-doening: hij is op de dag vóór levering nog wél lopend eigenaar
    // ([2026-01-01, 2027-04-01) bevat 2027-03-31) — geweigerd.
    await expect(
      service.wisselEigenaar(
        s.vveId,
        s.eenheidId,
        { nieuwePersoonId: s.eigenaarA, leveringsdatum: '2027-04-01' },
        s.beheerderId,
      ),
    ).rejects.toThrow(/al \(mede\)eigenaar/);

    // Een terugwissel naar de vorige eigenaar mag legaal: zijn historische
    // periode (t/m 2027-03-31) en de nieuwe [2027-05-01,) overlappen niet,
    // dus de per-persoon-EXCLUDE houdt dit toe.
    const terug = await service.wisselEigenaar(
      s.vveId,
      s.eenheidId,
      { nieuwePersoonId: s.eigenaarA, leveringsdatum: '2027-05-01' },
      s.beheerderId,
    );
    const naTerug = await service.eigenaren(s.vveId, s.eenheidId);
    const terugRij = naTerug.find((r) => r.eigenaarschapId === terug.nieuwId);
    expect(terugRij?.vanaf).toBe('2027-05-01');
    expect(terugRij?.isPrimairContact).toBe(true);
  });

  it('AC2.5 — verrekenoverzicht: rato over dagen, som exact het jaartotaal', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const leveringsdatum = '2027-07-01';
    const jaar = 2027;

    // Twee nota's in het jaar, beide op de (oude) eigenaar — historie blijft
    // gekoppeld (AC2.5); het totaal van de eenheid is de verdelingsbasis.
    await seedNotas(s, jaar, [
      { kenmerkSufix: 'A', factuurdatum: `${String(jaar)}-02-01`, centen: 365_00 },
      { kenmerkSufix: 'B', factuurdatum: `${String(jaar)}-08-01`, centen: 182_00 },
    ]);
    const jaartotaal = 365_00 + 182_00;

    await service.wisselEigenaar(
      s.vveId,
      s.eenheidId,
      { nieuwePersoonId: s.eigenaarB, leveringsdatum },
      s.beheerderId,
    );

    const overzicht = await service.verrekenOverzicht(s.vveId, s.eenheidId, leveringsdatum);
    expect(overzicht.eenheidCode).toBe('A-01');
    expect(overzicht.jaar).toBe(jaar);
    expect(overzicht.totaalCenten).toBe(jaartotaal);

    // Verkoper: 1 januari t/m 30 juni = 181 dagen (2027 is geen schrikkeljaar);
    // koper: 1 juli t/m 31 december = 184 dagen.
    const verkoper = overzicht.rijen.find((r) => r.persoonId === s.eigenaarA);
    const koper = overzicht.rijen.find((r) => r.persoonId === s.eigenaarB);
    expect(verkoper?.dagenInJaar).toBe(181);
    expect(koper?.dagenInJaar).toBe(184);

    // Som exact gelijk aan het jaartotaal (verdeelGrootsteRest-garantie) en
    // de verdeling volgt de dagen-verhouding 181/365 en 184/365. De
    // referentie is deterministisch nerekend: 54.700 cent × 181/365 =
    // 27.125,2… → verkoper 27.125, koper de rest 27.575 (grootste rest).
    const verkoperBedrag = Bedrag.vanCenten(verkoper?.teBetalenCenten ?? 0);
    const koperBedrag = Bedrag.vanCenten(koper?.teBetalenCenten ?? 0);
    expect(verkoperBedrag.plus(koperBedrag).centen).toBe(54_700);
    expect(verkoperBedrag.centen).toBe(27_125);
    expect(koperBedrag.centen).toBe(27_575);
  });

  it('AC2.5 — openstaande posten van de verkoper worden gesignaleerd', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const leveringsdatum = '2027-03-01';
    const jaar = 2027;

    await seedNotas(s, jaar, [
      { kenmerkSufix: 'C', factuurdatum: `${String(jaar)}-01-15`, centen: 120_00 },
    ]);

    await service.wisselEigenaar(
      s.vveId,
      s.eenheidId,
      { nieuwePersoonId: s.eigenaarB, leveringsdatum },
      s.beheerderId,
    );

    const overzicht = await service.verrekenOverzicht(s.vveId, s.eenheidId, leveringsdatum);
    expect(overzicht.openstaandePostenOudeEigenaarCenten).toBe(120_00);
  });

  it('weigert een wissel vóór vandaag en op een eenheid zonder eigenaarschap', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    // Leveringsdatum in het verleden.
    await expect(
      service.wisselEigenaar(
        s.vveId,
        s.eenheidId,
        { nieuwePersoonId: s.eigenaarB, leveringsdatum: '2026-01-01' },
        s.beheerderId,
      ),
    ).rejects.toThrow(/niet in het verleden/);

    // Eenheid zonder lopend eigenaarschap.
    const [leeg] = await db.db
      .insert(wooneenheid)
      .values({ vveId: s.vveId, code: 'B-01' })
      .returning({ id: wooneenheid.id });
    if (leeg === undefined) throw new Error('tweede eenheid-seed faalde');
    await expect(
      service.wisselEigenaar(
        s.vveId,
        leeg.id,
        { nieuwePersoonId: s.eigenaarB, leveringsdatum: '2027-09-01' },
        s.beheerderId,
      ),
    ).rejects.toThrow(/geen lopend eigenaarschap/);
  });
});

/** Uniek-kenmerk voor de derde-persoon-seed (gebruikt het vve-id). */
function nVan(id: bigint): string {
  return String(id);
}
