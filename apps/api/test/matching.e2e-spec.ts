/**
 * Integratietest — matchingmotor (B05, AC7.4–7.6, test #13).
 *
 * Test #13 in drie delen: afletteren op betalingskenmerk, op End-to-End-ID en
 * op tegenrekening + exact bedrag werkt; bij een afwijkend bedrag volgt alléén
 * een voorstel en wordt er niets afgeboekt.
 *
 * Dat laatste is de kern van dit blok. Automatisch afboeken op een afwijkend
 * bedrag maakt van één verkeerde betaling een reeks scheve openstaande posten,
 * en die vindt niemand meer terug.
 */

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bankBoekingsregel,
  bankmutatie,
  bankrekening,
  grootboekrekening,
  nota,
  persoon,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { maakBoekjaarService } from '../src/financieel/boekjaar-service.js';
import {
  beveiligIban,
  laadIbanSleutels,
  type IbanSleutels,
} from '../src/bank/iban-versleuteling.js';
import { maakMatchingService, type MatchingService } from '../src/bank/matching-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

const EIGEN_IBAN = 'NL02ABNA0123456789';
const EIGENAAR_IBAN = 'NL20INGB0001234567';

describe('Matchingmotor (B05, test #13)', () => {
  let db: TestPgDb | undefined;
  let dienst: MatchingService | undefined;
  let sleutels: IbanSleutels | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    process.env['IBAN_VERSLEUTEL_SLEUTEL'] = 'b'.repeat(64);
    process.env['IBAN_HMAC_SLEUTEL'] = 'c'.repeat(64);
    sleutels = laadIbanSleutels();
    dienst = maakMatchingService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  interface Opstelling {
    vveId: bigint;
    persoonId: bigint;
    eenheidId: bigint;
    rekeningId: bigint;
    importId: bigint;
    boekjaarId: bigint;
  }

  async function seed(): Promise<Opstelling> {
    if (!db || !sleutels) throw new Error('geen setup');
    teller += 1;
    const n = `${String(teller)}-${String(process.pid)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B05-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b05-${n}@test.vve`, achternaam: 'Eigenaar' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: '001', breukdeelTeller: 1, breukdeelNoemer: 1 })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid faalde');

    const eigen = beveiligIban(EIGEN_IBAN, sleutels);
    const [r] = await db.db
      .insert(bankrekening)
      .values({
        vveId: v.id,
        naam: 'Betaalrekening',
        ibanVersleuteld: eigen.versleuteld,
        ibanHmac: eigen.hmac,
        ibanMasker: eigen.masker,
      })
      .returning({ id: bankrekening.id });
    if (r === undefined) throw new Error('rekening faalde');

    // Een import-rij is verplicht als FK op de mutatie.
    const rijen = await db.db.execute<{ id: string }>(sql`
      insert into bank_import (vve_id, bankrekening_id, formaat, beginsaldo_cent,
                               eindsaldo_cent, door_persoon_id)
      values (${v.id}, ${r.id}, 'test', 0, 0, ${p.id})
      returning id
    `);
    const importId = BigInt(rijen.rows[0]?.id ?? '0');

    // Machtiging koppelt de privé-IBAN van de eigenaar aan de eenheid.
    const eigenaar = beveiligIban(EIGENAAR_IBAN, sleutels);
    await db.db.execute(sql`
      insert into sepa_machtiging (vve_id, wooneenheid_id, persoon_id, kenmerk,
                                   iban_versleuteld, iban_hmac, iban_masker,
                                   tenaamstelling, ondertekend_op, status)
      values (${v.id}, ${e.id}, ${p.id}, ${'MND' + n},
              ${eigenaar.versleuteld}, ${eigenaar.hmac}, ${eigenaar.masker},
              'J. Eigenaar', '2026-01-01', 'actief')
    `);

    const boekjaarSvc = maakBoekjaarService({ db: db.db });
    const { id: boekjaarId } = await boekjaarSvc.maakBoekjaar(
      v.id,
      { jaar: 2026, startDatum: '2026-01-01', eindDatum: '2026-12-31' },
      p.id,
    );

    return {
      vveId: v.id,
      persoonId: p.id,
      eenheidId: e.id,
      rekeningId: r.id,
      importId,
      boekjaarId,
    };
  }

  async function maakNota(
    o: Opstelling,
    nummer: string,
    kenmerk: string,
    centen: number,
    vervaldatum = '2026-01-31',
  ): Promise<bigint> {
    if (!db) throw new Error('geen setup');
    const [rij] = await db.db
      .insert(nota)
      .values({
        vveId: o.vveId,
        wooneenheidId: o.eenheidId,
        persoonId: o.persoonId,
        boekjaarId: o.boekjaarId,
        nummer,
        type: 'periodieke_bijdrage',
        factuurdatum: '2026-01-01',
        vervaldatum,
        bedragCent: centen,
        openstaandCent: centen,
        betalingskenmerk: kenmerk,
      })
      .returning({ id: nota.id });
    if (rij === undefined) throw new Error('nota faalde');
    return rij.id;
  }

  async function maakMutatie(
    o: Opstelling,
    velden: {
      bedragCent: number;
      omschrijving?: string;
      eindTotEindId?: string | null;
      tegenIban?: string | null;
      tegenpartijNaam?: string | null;
      volgnummer?: number;
    },
  ): Promise<bigint> {
    if (!db || !sleutels) throw new Error('geen setup');
    const tegen =
      velden.tegenIban === undefined || velden.tegenIban === null
        ? null
        : beveiligIban(velden.tegenIban, sleutels);
    const [rij] = await db.db
      .insert(bankmutatie)
      .values({
        vveId: o.vveId,
        bankrekeningId: o.rekeningId,
        bankImportId: o.importId,
        boekdatum: '2026-02-01',
        bedragCent: velden.bedragCent,
        omschrijving: velden.omschrijving ?? '',
        eindTotEindId: velden.eindTotEindId ?? null,
        tegenrekeningVersleuteld: tegen?.versleuteld ?? null,
        tegenrekeningHmac: tegen?.hmac ?? null,
        tegenrekeningMasker: tegen?.masker ?? null,
        tegenpartijNaam: velden.tegenpartijNaam ?? null,
        volgnummer: velden.volgnummer ?? 1,
        duplicaatHash: Buffer.from(
          `${String(o.vveId)}-${String(velden.volgnummer ?? 1)}-${String(velden.bedragCent)}-${String(teller)}`,
        ),
      })
      .returning({ id: bankmutatie.id });
    if (rij === undefined) throw new Error('mutatie faalde');
    return rij.id;
  }

  it('test #13a: aflettert op betalingskenmerk in de omschrijving', async () => {
    if (!dienst) throw new Error('geen setup');
    const o = await seed();
    const notaId = await maakNota(o, '2026-0001', 'NOTA20260001', 12_500);
    await maakMutatie(o, {
      bedragCent: 12_500,
      // Rommelige bankomschrijving: spaties en hoofdletters wijken af.
      omschrijving: 'Overboeking inzake nota 2026 0001 bijdrage februari',
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    expect(ronde.exact).toBe(1);
    const [m] = ronde.mutaties;
    expect(m?.voorstellen[0]?.soort).toBe('betalingskenmerk');
    expect(m?.voorstellen[0]?.notaId).toBe(notaId);
    expect(m?.voorstellen[0]?.zekerheid).toBe(100);
  });

  it('test #13b: aflettert op End-to-End-ID', async () => {
    if (!dienst) throw new Error('geen setup');
    const o = await seed();
    const notaId = await maakNota(o, '2026-0002', 'NOTA20260002', 9_900);
    await maakMutatie(o, {
      bedragCent: 9_900,
      omschrijving: 'SEPA incasso',
      eindTotEindId: 'NOTA20260002',
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    const [m] = ronde.mutaties;
    // Het kenmerk staat niet in de omschrijving, dus stap 1 vindt niets en
    // stap 2 moet het doen.
    expect(m?.voorstellen[0]?.soort).toBe('end_to_end');
    expect(m?.voorstellen[0]?.notaId).toBe(notaId);
  });

  it('test #13c: tegenrekening + exact bedrag levert een exacte match', async () => {
    if (!dienst) throw new Error('geen setup');
    const o = await seed();
    const notaId = await maakNota(o, '2026-0003', 'NOTA20260003', 15_000);
    await maakMutatie(o, {
      bedragCent: 15_000,
      omschrijving: 'maandelijkse overboeking',
      tegenIban: EIGENAAR_IBAN,
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    const [m] = ronde.mutaties;
    expect(m?.voorstellen[0]?.soort).toBe('iban_bedrag');
    expect(m?.voorstellen[0]?.notaId).toBe(notaId);
    expect(ronde.exact).toBe(1);
  });

  it('test #13d: bij een afwijkend bedrag volgt alleen een voorstel', async () => {
    if (!db || !dienst) throw new Error('geen setup');
    const o = await seed();
    await maakNota(o, '2026-0004', 'NOTA20260004', 15_000, '2026-01-31');
    await maakNota(o, '2026-0005', 'NOTA20260005', 15_000, '2026-02-28');
    // Betaalt 200 euro terwijl er twee posten van 150 open staan.
    await maakMutatie(o, {
      bedragCent: 20_000,
      omschrijving: 'overboeking zonder kenmerk',
      tegenIban: EIGENAAR_IBAN,
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    expect(ronde.exact).toBe(0);
    expect(ronde.voorstel).toBe(1);
    const [m] = ronde.mutaties;
    expect(m?.voorstellen.every((v) => v.soort === 'iban_fifo')).toBe(true);
    expect(m?.voorstellen.every((v) => v.zekerheid < 100)).toBe(true);
    // FIFO: eerst de oudste nota volledig, dan de rest op de volgende.
    expect(m?.voorstellen[0]?.bedragCent).toBe(15_000);
    expect(m?.voorstellen[1]?.bedragCent).toBe(5_000);

    // En er is niets afgeboekt: de nota's staan nog volledig open.
    const open = await db.db
      .select({ openstaand: nota.openstaandCent })
      .from(nota)
      .where(eq(nota.vveId, o.vveId));
    expect(open.every((n) => n.openstaand === 15_000)).toBe(true);
  });

  it('AC7.6: een overboeking tussen twee eigen rekeningen heet intern', async () => {
    if (!db || !dienst || !sleutels) throw new Error('geen setup');
    const o = await seed();
    // Tweede eigen rekening: de spaarrekening van de VvE.
    const spaar = beveiligIban('NL93RABO0987654321', sleutels);
    await db.db.insert(bankrekening).values({
      vveId: o.vveId,
      naam: 'Spaarrekening',
      ibanVersleuteld: spaar.versleuteld,
      ibanHmac: spaar.hmac,
      ibanMasker: spaar.masker,
    });
    await maakMutatie(o, {
      bedragCent: -50_000,
      omschrijving: 'naar reservefonds',
      tegenIban: 'NL93RABO0987654321',
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    const [m] = ronde.mutaties;
    expect(m?.voorstellen[0]?.soort).toBe('intern');
  });

  it('AC7.5: een eigen boekingsregel levert een kostenrekening op', async () => {
    if (!db || !dienst) throw new Error('geen setup');
    const o = await seed();
    const [rekening] = await db.db
      .select({ id: grootboekrekening.id })
      .from(grootboekrekening)
      .where(and(eq(grootboekrekening.vveId, o.vveId), eq(grootboekrekening.nummer, '4100')))
      .limit(1);
    if (rekening === undefined) throw new Error('rekening ontbreekt');
    await db.db.insert(bankBoekingsregel).values({
      vveId: o.vveId,
      bevat: 'VITENS',
      grootboekrekeningId: rekening.id,
    });
    await maakMutatie(o, {
      bedragCent: -8_000,
      omschrijving: 'Vitens drinkwater termijn 3',
      tegenIban: 'NL93RABO0987654321',
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    const [m] = ronde.mutaties;
    expect(m?.voorstellen[0]?.soort).toBe('boekingsregel');
    expect(m?.voorstellen[0]?.grootboekrekeningId).toBe(rekening.id);
    expect(m?.uitkomst).toBe('voorstel');
  });

  it('wat nergens op past, blijft zonder voorstel in de werkbak staan', async () => {
    if (!dienst) throw new Error('geen setup');
    const o = await seed();
    await maakMutatie(o, { bedragCent: -1_234, omschrijving: 'Onbekende afschrijving' });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    expect(ronde.geen).toBe(1);

    const bak = await dienst.werkbak(o.vveId);
    expect(bak).toHaveLength(1);
    expect(bak[0]?.voorstellen).toHaveLength(0);
  });

  it('dezelfde nota wordt binnen één ronde niet tweemaal exact gematcht', async () => {
    if (!dienst) throw new Error('geen setup');
    const o = await seed();
    await maakNota(o, '2026-0006', 'NOTA20260006', 10_000);
    await maakMutatie(o, {
      bedragCent: 10_000,
      omschrijving: 'betaling NOTA20260006',
      volgnummer: 1,
    });
    await maakMutatie(o, {
      bedragCent: 10_000,
      omschrijving: 'nogmaals NOTA20260006',
      volgnummer: 2,
    });

    const ronde = await dienst.matchOpenstaande(o.vveId);
    // De eerste komt exact uit; de tweede vindt de nota niet meer vrij.
    expect(ronde.exact).toBe(1);
    expect(ronde.mutaties[1]?.uitkomst).not.toBe('exact');
  });
});
