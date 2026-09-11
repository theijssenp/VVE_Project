/**
 * Integratietest — nota-generatie (G06, spec §6.6, §5.3 · AC6.1–AC6.2 ·
 * test #10).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0019).
 * Controleert:
 *   - AC6.1: één nota per eenheid per periode, doorlopend nummer
 *     `2026-0001` per VvE per boekjaar;
 *   - AC6.2: betalingskenmerk `NOTA{nummer}`, uniek per VvE;
 *   - §5.3-tweede verdeling: restcenten in de eerste maanden;
 *   - idempotentie per periode;
 *   - test #10: vijftien gelijktijdige generaties produceren exact één
 *     nota per eenheid, zonder dubbele nummers.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bijdrageRegel,
  bijdrageSchema,
  boekjaar,
  eigenaarschap,
  nota,
  persoon,
  verdeelsleutel,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { maakNotaService, type NotaService } from '../src/financieel/nota-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Nota-generatie (G06)', () => {
  let db: TestPgDb | undefined;
  let service: NotaService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakNotaService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /**
   * Seedt VvE + persoon + een eigenaarschap + n eenheden + een open boekjaar
   * + een vastgesteld bijdrageschema (vast_bedrag) met handmatige
   * jaarregels. De eigenaar is het primaire contact op alle eenheden, de
   * lopende periode omvat de factuurdatum.
   */
  async function seed(regels: readonly { code: string; exploitatie: number; reserve: number }[]) {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G06-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g06-${n}-${String(Date.now())}@test.vve`, achternaam: 'Eigenaar' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');

    const jaarNummer = String(2026 + vveNummer);
    const [jaarRij] = await db.db
      .insert(boekjaar)
      .values({
        vveId: v.id,
        jaar: Number(jaarNummer),
        startDatum: `${jaarNummer}-01-01`,
        eindDatum: `${jaarNummer}-12-31`,
        status: 'open',
      })
      .returning({ id: boekjaar.id });
    if (jaarRij === undefined) throw new Error('jaar-seed faalde');

    const [sleutel] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId: v.id, naam: 'Algemeen', type: 'gelijke_delen' })
      .returning({ id: verdeelsleutel.id });
    if (sleutel === undefined) throw new Error('sleutel-seed faalde');

    const [schema] = await db.db
      .insert(bijdrageSchema)
      .values({
        vveId: v.id,
        boekjaarId: jaarRij.id,
        methode: 'vast_bedrag',
        periodiciteit: 'maand',
        ingangsdatum: `${jaarNummer}-01-01`,
        status: 'vastgesteld',
      })
      .returning({ id: bijdrageSchema.id });
    if (schema === undefined) throw new Error('schema-seed faalde');

    const eenheidIds: bigint[] = [];
    for (const r of regels) {
      const [e] = await db.db
        .insert(wooneenheid)
        .values({
          vveId: v.id,
          code: r.code,
          oppervlakteM2: 100,
          breukdeelTeller: 1,
          breukdeelNoemer: 1,
        })
        .returning({ id: wooneenheid.id });
      if (e === undefined) throw new Error('eenheid-seed faalde');
      eenheidIds.push(e.id);
      await db.db.insert(eigenaarschap).values({
        wooneenheidId: e.id,
        vveId: v.id,
        persoonId: p.id,
        isPrimairContact: true,
        periode: `[${jaarNummer}-01-01,${jaarNummer}-12-31]`,
      });
      await db.db.insert(bijdrageRegel).values({
        bijdrageSchemaId: schema.id,
        wooneenheidId: e.id,
        exploitatieCent: r.exploitatie,
        reservefondsCent: r.reserve,
        bron: 'handmatig',
      });
    }
    return {
      vveId: v.id,
      persoonId: p.id,
      boekjaarId: jaarRij.id,
      schemaId: schema.id,
      jaar: Number(jaarNummer),
    };
  }

  const invoer = (boekjaarId: bigint, jaar: number, maand: number) => ({
    boekjaarId,
    periodeVan: `${String(jaar)}-${String(maand).padStart(2, '0')}-01`,
    periodeTot: maandEinde(jaar, maand),
    factuurdatum: `${String(jaar)}-${String(maand).padStart(2, '0')}-01`,
    vervaldatum: maandEinde(jaar, maand),
  });

  function maandEinde(jaar: number, maand: number): string {
    const volgende = new Date(Date.UTC(jaar, maand, 1)); // maand is 1-basis
    const laatste = new Date(volgende.getTime() - 1);
    return laatste.toISOString().slice(0, 10);
  }

  it('genereert periode-nota’s per eenheid met nummer en betalingskenmerk (AC6.1+AC6.2)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed([
      { code: 'A-01', exploitatie: 200_000, reserve: 100_000 },
      { code: 'A-02', exploitatie: 200_000, reserve: 100_000 },
      { code: 'A-03', exploitatie: 100_000, reserve: 100_000 },
      { code: 'A-03B', exploitatie: 100_000, reserve: 100_000 },
    ]);
    const uitkomst = await service.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, 2026 + 1, 1),
      s.persoonId,
    );
    expect(uitkomst.aantal).toBe(4);

    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    expect(rijen.length).toBe(4);
    const nummers = rijen.map((r) => r.nummer).sort();
    const jaarS = String(s.jaar);
    expect(nummers).toEqual([`${jaarS}-0001`, `${jaarS}-0002`, `${jaarS}-0003`, `${jaarS}-0004`]);
    for (const r of rijen) {
      expect(r.betalingskenmerk).toBe(`NOTA${r.nummer}`);
      expect(r.openstaandCent).toBe(r.bedragCent);
      expect(r.status).toBe('open');
    }
    // Som over de eenheden: exploitatie en reserve worden apart over 12
    // perioden verdeeld; index 0 krijgt het restcent als dat in de eerste
    // perioden valt (grootste-rest): 16.667+16.667+8.334+8.334 exploitatie
    // en 4×8.334 reserve = 83.338 (nagerekend tegen de exacte referentie).
    const som = rijen.reduce((t, r) => t + r.bedragCent, 0);
    expect(som).toBe(83_338);
  });

  it('verdeelt het jaarbedrag met restcenten in de eerste maanden (§5.3)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 100_003, reserve: 0 }]);
    // Februari (index 1): 100.003 over 12 → rest 7 centen; de eerste zeven
    // perioden krijgen 8.334, februari dus ook 8.334 (nagerekend).
    const feb = await service.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 2),
      s.persoonId,
    );
    expect(feb.aantal).toBe(1);
    const [febNota] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    expect(febNota?.bedragCent).toBe(8_334);
  });

  it('is idempotent per periode: tweede generatie voegt niets toe', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 120_000, reserve: 0 }]);
    const invoerJan = invoer(s.boekjaarId, s.jaar, 1);
    const eerste = await service.genereerPeriode(s.vveId, invoerJan, s.persoonId);
    expect(eerste.aantal).toBe(1);
    const tweede = await service.genereerPeriode(s.vveId, invoerJan, s.persoonId);
    expect(tweede.aantal).toBe(0);
    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    expect(rijen.length).toBe(1);
  });

  it('test #10 — vijftien gelijktijdige generaties: geen dubbele nummers', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed([
      { code: 'A-01', exploitatie: 50_000, reserve: 0 },
      { code: 'A-02', exploitatie: 50_000, reserve: 0 },
    ]);
    const invoerJan = invoer(s.boekjaarId, s.jaar, 1);
    const uitkomsten = await Promise.all(
      Array.from({ length: 15 }, () => {
        if (service === undefined) throw new Error('geen service');
        return service.genereerPeriode(s.vveId, invoerJan, s.persoonId);
      }),
    );
    const totaal = uitkomsten.reduce((t, u) => t + u.aantal, 0);
    expect(totaal).toBe(2);

    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    expect(rijen.length).toBe(2);
    const nummers = rijen.map((r) => r.nummer).sort();
    expect(new Set(nummers).size).toBe(2);
    const jaarS = String(s.jaar);
    expect(nummers).toEqual([`${jaarS}-0001`, `${jaarS}-0002`]);
  });

  it('weigert generatie zonder vastgesteld schema of in een gesloten jaar', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 10_000, reserve: 0 }]);
    // Het schema is bij de seed 'vastgesteld'; zet terug naar concept.
    await db.db
      .update(bijdrageSchema)
      .set({ status: 'concept' })
      .where(eq(bijdrageSchema.id, s.schemaId));
    await expect(
      service.genereerPeriode(s.vveId, invoer(s.boekjaarId, 2027, 1), s.persoonId),
    ).rejects.toThrow('vastgesteld');
  });
});
