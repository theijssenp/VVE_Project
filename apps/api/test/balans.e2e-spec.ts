/**
 * Integratietest — proefbalans, saldibalans en grootboek (B07, M9 · AC9.8).
 *
 * Controleert:
 *   - de proefbalans telt op: som debet == som credit, en de saldi ook;
 *   - het verschil tussen proef- en saldibalans: een rekening met boekingen aan
 *     beide kanten houdt twee tellingen maar één saldo;
 *   - `peildatum` snijdt op de dag af (tussentijdse stand);
 *   - het grootboek toont de mutaties chronologisch met een lopend saldo dat op
 *     het saldo uit de balans uitkomt;
 *   - AC9.8: vanuit een mutatie is de boeking op te halen, met `bron` en
 *     `bron_id` naar het brondocument;
 *   - tenant-isolatie: het boekjaar en de rekening van een andere VvE bestaan
 *     niet, ook niet met een geldig id.
 *
 * De balanscontrole wordt hier met de hand nagerekend en niet uit de service
 * overgenomen: een test die `inBalans` gelooft omdat de service het zegt, toetst
 * niets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import { grootboekrekening, persoon, vve } from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { Regel, maakBoekhouding, type Boekhouding } from '../src/financieel/boekhouding.js';
import { NietGevondenFout } from '../src/financieel/boekhouding.js';
import { maakBoekjaarService, type BoekjaarService } from '../src/financieel/boekjaar-service.js';
import { maakBalansService, type BalansService } from '../src/financieel/balans-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Proef- en saldibalans (B07, AC9.8)', () => {
  let db: TestPgDb | undefined;
  let boekhouding: Boekhouding | undefined;
  let boekjaarSvc: BoekjaarService | undefined;
  let balans: BalansService | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    boekhouding = maakBoekhouding({ db: db.db });
    boekjaarSvc = maakBoekjaarService({ db: db.db });
    balans = maakBalansService({ db: db.db });
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
      .values({ naam: `B07-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b07-${n}@test.vve`, achternaam: 'Balans' })
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

  /** Twee boekingen in februari en maart, plus een tegenboeking op 1300. */
  async function boekDrie(vveId: bigint, jaarId: bigint, persoonId: bigint): Promise<void> {
    if (!boekhouding) throw new Error('geen setup');
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-02-01',
        omschrijving: 'Bijdrage februari',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1300', Bedrag.vanCenten(12_500)),
          Regel.credit('8100', Bedrag.vanCenten(10_000)),
          Regel.credit('8150', Bedrag.vanCenten(2_500)),
        ],
      },
      persoonId,
    );
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-03-01',
        omschrijving: 'Bijdrage maart',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1300', Bedrag.vanCenten(12_500)),
          Regel.credit('8100', Bedrag.vanCenten(10_000)),
          Regel.credit('8150', Bedrag.vanCenten(2_500)),
        ],
      },
      persoonId,
    );
    // Betaling: de debiteur loopt terug. Hierdoor heeft 1300 boekingen aan
    // beide kanten — precies het geval waarin proef- en saldibalans verschillen.
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-03-15',
        omschrijving: 'Betaling februari',
        bron: 'betaling',
        regels: [
          Regel.debet('1100', Bedrag.vanCenten(12_500)),
          Regel.credit('1300', Bedrag.vanCenten(12_500)),
        ],
      },
      persoonId,
    );
  }

  it('telt op: som debet == som credit, en de saldi ook', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    const uit = await balans.proefSaldiBalans(vveId, jaarId);

    // Met de hand nageteld, niet overgenomen van de service.
    const debet = uit.regels.reduce((s, r) => s + r.debetTotaalCent, 0);
    const credit = uit.regels.reduce((s, r) => s + r.creditTotaalCent, 0);
    expect(debet).toBe(credit);
    // Drie boekingen, elk 12.500 aan de debetkant: twee nota's (1300) en de
    // betaling (1100). Handmatig: 37.500 debet, en evenveel credit.
    expect(debet).toBe(12_500 + 12_500 + 12_500);
    expect(uit.totaalDebetCent).toBe(debet);
    expect(uit.totaalCreditCent).toBe(credit);
    expect(uit.totaalSaldoDebetCent).toBe(uit.totaalSaldoCreditCent);
    expect(uit.inBalans).toBe(true);
  });

  it('proefbalans telt beide kanten, saldibalans houdt er één over', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    const uit = await balans.proefSaldiBalans(vveId, jaarId);
    const debiteuren = uit.regels.find((r) => r.nummer === '1300');
    if (debiteuren === undefined) throw new Error('rekening 1300 ontbreekt');

    // Twee nota's debet, één betaling credit.
    expect(debiteuren.debetTotaalCent).toBe(25_000);
    expect(debiteuren.creditTotaalCent).toBe(12_500);
    // Het saldo staat aan één kant en de andere kolom blijft leeg.
    expect(debiteuren.saldoDebetCent).toBe(12_500);
    expect(debiteuren.saldoCreditCent).toBe(0);
  });

  it('toont ook rekeningen zonder mutaties', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    const uit = await balans.proefSaldiBalans(vveId, jaarId);
    // Het standaardschema telt 37 rekeningen (§5.7); er is op vier geboekt.
    expect(uit.regels.length).toBeGreaterThan(4);
    const leeg = uit.regels.filter((r) => r.debetTotaalCent === 0 && r.creditTotaalCent === 0);
    expect(leeg.length).toBeGreaterThan(0);
  });

  it('peildatum snijdt af op de dag', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    // Alleen februari: één nota, geen betaling.
    const tot = await balans.proefSaldiBalans(vveId, jaarId, '2026-02-28');
    expect(tot.peildatum).toBe('2026-02-28');
    expect(tot.totaalDebetCent).toBe(12_500);
    expect(tot.inBalans).toBe(true);
    const debiteuren = tot.regels.find((r) => r.nummer === '1300');
    expect(debiteuren?.debetTotaalCent).toBe(12_500);
    expect(debiteuren?.creditTotaalCent).toBe(0);

    // De dag van de betaling zelf telt mee: `<=`, niet `<`.
    const inclusief = await balans.proefSaldiBalans(vveId, jaarId, '2026-03-15');
    expect(inclusief.totaalDebetCent).toBe(37_500);
  });

  it('grootboek: chronologisch, met een lopend saldo dat op de balans uitkomt', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    const balansUit = await balans.proefSaldiBalans(vveId, jaarId);
    const rekening = balansUit.regels.find((r) => r.nummer === '1300');
    if (rekening === undefined) throw new Error('rekening 1300 ontbreekt');

    const gb = await balans.grootboek(vveId, jaarId, rekening.rekeningId);
    expect(gb.nummer).toBe('1300');
    expect(gb.mutaties.map((m) => m.datum)).toEqual(['2026-02-01', '2026-03-01', '2026-03-15']);
    expect(gb.mutaties.map((m) => m.lopendSaldoCent)).toEqual([12_500, 25_000, 12_500]);
    // Het eindsaldo van het grootboek is hetzelfde getal als in de saldibalans.
    expect(gb.eindsaldoCent).toBe(rekening.saldoDebetCent);
  });

  it('AC9.8: vanuit een mutatie is de boeking met bron op te halen', async () => {
    if (!balans) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekDrie(vveId, jaarId, persoonId);

    const balansUit = await balans.proefSaldiBalans(vveId, jaarId);
    const rekening = balansUit.regels.find((r) => r.nummer === '1300');
    if (rekening === undefined) throw new Error('rekening 1300 ontbreekt');
    const gb = await balans.grootboek(vveId, jaarId, rekening.rekeningId);

    const betaling = gb.mutaties.find((m) => m.bron === 'betaling');
    if (betaling === undefined) throw new Error('geen betaalmutatie');

    const detail = await balans.boekingDetail(vveId, betaling.boekingId);
    expect(detail.bron).toBe('betaling');
    expect(detail.omschrijving).toBe('Betaling februari');
    // De boeking zelf is in balans; dat is waar de doorklik op uitkomt.
    expect(detail.totaalDebetCent).toBe(detail.totaalCreditCent);
    expect(detail.regels.map((r) => r.nummer).sort()).toEqual(['1100', '1300']);
  });

  it('tenant-isolatie: boekjaar en rekening van een andere VvE bestaan niet', async () => {
    if (!balans) throw new Error('geen setup');
    const a = await seed();
    const b = await seed();
    await boekDrie(b.vveId, b.jaarId, b.persoonId);

    // Het boekjaar van B, bevraagd als A.
    await expect(balans.proefSaldiBalans(a.vveId, b.jaarId)).rejects.toBeInstanceOf(
      NietGevondenFout,
    );

    // En een rekening van B binnen het eigen boekjaar van A.
    const balansB = await balans.proefSaldiBalans(b.vveId, b.jaarId);
    const rekeningB = balansB.regels[0];
    if (rekeningB === undefined) throw new Error('geen rekening');
    await expect(balans.grootboek(a.vveId, a.jaarId, rekeningB.rekeningId)).rejects.toBeInstanceOf(
      NietGevondenFout,
    );
  });
});
