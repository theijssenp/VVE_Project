/**
 * Integratietest — debiteurenoverzicht (G09, spec §6.6 · AC6.4/AC6.8).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0021).
 * Controleert:
 *   - AC6.4: ouderdomsanalyse in de vier buckets (0–30/31–60/61–90/90+) plus
 *     nog-niet-vervallen, som == totaal openstaand (invariant);
 *   - per eenheid: openstaand en oudste vervaldatum;
 *   - AC6.8: dossier chronologisch — nota's vóór betalingen, met soort en
 *     kenmerk;
 *   - betaalde nota's tellen niet mee in de analyse.
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
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { maakBetalingService, type BetalingService } from '../src/financieel/betaling-service.js';
import {
  maakDebiteurenService,
  type DebiteurenService,
} from '../src/financieel/debiteuren-service.js';
import { maakNotaService, type NotaService } from '../src/financieel/nota-service.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Debiteurenoverzicht (G09, AC6.4/AC6.8)', () => {
  let db: TestPgDb | undefined;
  let service: DebiteurenService | undefined;
  let notaService: NotaService | undefined;
  let betalingService: BetalingService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakDebiteurenService({ db: db.db, klok: new SystemKlok() });
    notaService = maakNotaService({ db: db.db });
    betalingService = maakBetalingService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + eigenaar + schema + nota's van drie vervaldatums. */
  async function seed() {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G09-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g09-${n}-${String(Date.now())}@test.vve`, achternaam: 'Eigenaar' })
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

    const [e] = await db.db
      .insert(wooneenheid)
      .values({
        vveId: v.id,
        code: 'A-01',
        oppervlakteM2: 100,
        breukdeelTeller: 1,
        breukdeelNoemer: 1,
      })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid-seed faalde');
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
      exploitatieCent: 360_000,
      reservefondsCent: 0,
      bron: 'handmatig',
    });
    return {
      vveId: v.id,
      persoonId: p.id,
      boekjaarId: jaarRij.id,
      jaar: Number(jaarNummer),
      jaarS: jaarNummer,
      eenheidId: e.id,
    };
  }

  function invoer(boekjaarId: bigint, jaar: number, maand: number) {
    return {
      boekjaarId,
      periodeVan: `${String(jaar)}-${String(maand).padStart(2, '0')}-01`,
      periodeTot: maandEinde(jaar, maand),
      factuurdatum: `${String(jaar)}-${String(maand).padStart(2, '0')}-01`,
      vervaldatum: maandEinde(jaar, maand),
    };
  }

  function maandEinde(jaar: number, maand: number): string {
    const volgende = new Date(Date.UTC(jaar, maand, 1)); // maand is 1-basis
    const laatste = new Date(volgende.getTime() - 1);
    return laatste.toISOString().slice(0, 10);
  }

  it('AC6.4 — ouderdomsanalyse: drie vervallen maanden in de juiste buckets, som == totaal', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed();
    // Drie maanden nota's: 36.000/12 = 3.000 cent (rest 0), vervaldatum =
    // maandeinde. Peildatum 2027-03-15: januari vervalt 60+ dagen geleden
    // (31–60), februari 13 dagen (0–30), maart nog niet vervallen.
    const jaar = Number(s.jaarS);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 2), s.persoonId);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 3), s.persoonId);

    const analyse = await service.ouderdomsanalyse(s.vveId, `${s.jaarS}-03-15`);
    // Elke maand-nota = 30.000 cent (360.000/12, index 0..2 zonder restcent
    // bij 36.000: rest 0 → 3.000×3? Nee: 360.000/12 = 30.000 exact).
    const per = 30_000;
    expect(analyse.dagen31Tot60).toBe(per); // januari, vervallen 2027-01-31 → 43 dagen
    expect(analyse.dagen0Tot30).toBe(per); // februari 2027-02-28 → 15 dagen
    expect(analyse.nogNietVervallen).toBe(per); // maart 2027-03-31 → toekomst
    expect(analyse.dagen61Tot90).toBe(0);
    expect(analyse.dagen90Plus).toBe(0);
    // Invariant: de som van de buckets == het totaal openstaand.
    const som =
      analyse.dagen0Tot30 +
      analyse.dagen31Tot60 +
      analyse.dagen61Tot90 +
      analyse.dagen90Plus +
      analyse.nogNietVervallen;
    expect(som).toBe(analyse.totaalCenten);
    expect(analyse.totaalCenten).toBe(90_000);
  });

  it('AC6.4 — per eenheid: openstaand en oudste vervaldatum', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed();
    const jaar = Number(s.jaarS);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 2), s.persoonId);

    const rijen = await service.perEenheid(s.vveId, `${s.jaarS}-03-15`);
    const eigen = rijen.find((r) => r.wooneenheidId === s.eenheidId);
    if (eigen === undefined) throw new Error('eenheid ontbreekt');
    expect(eigen.code).toBe('A-01');
    expect(eigen.openstaandCenten).toBe(60_000);
    expect(eigen.oudsteVervaldatum).toBe(`${s.jaarS}-01-31`);
  });

  it('AC6.8 — dossier: chronologisch, nota’s en betalingen gemengd, met soort', async () => {
    if (!db || !service || !notaService || !betalingService) throw new Error('geen setup');
    const s = await seed();
    const jaar = Number(s.jaarS);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');

    await betalingService.registreer(
      s.vveId,
      {
        datum: `${s.jaarS}-01-20`,
        bedragCent: 4_000,
        bron: 'bank',
        wooneenheidId: s.eenheidId,
        koppelingen: [{ notaId: notaRij.id, bedragCent: 4_000 }],
        omschrijving: 'Deelbetaling',
      },
      s.persoonId,
    );

    const dossier = await service.dossier(s.vveId, s.eenheidId, s.persoonId);
    expect(dossier.eenheidCode).toBe('A-01');
    expect(dossier.regels.length).toBe(2);
    // Chronologisch: de nota (01-01) vóór de betaling (01-20).
    expect(dossier.regels[0]?.soort).toBe('nota');
    expect(dossier.regels[0]?.datum).toBe(`${s.jaarS}-01-01`);
    expect(dossier.regels[1]?.soort).toBe('betaling');
    expect(dossier.regels[1]?.bedragCent).toBe(4_000);
    // Openstaand = bedrag − deelbetaling.
    const eersteRegel = dossier.regels[0];
    if (eersteRegel === undefined) throw new Error('dossier zonder nota-regel');
    expect(dossier.openstaandTotaalCenten).toBe(eersteRegel.bedragCent - 4_000);
  });

  it('betaalde nota’s tellen niet mee in de analyse', async () => {
    if (!db || !service || !notaService || !betalingService) throw new Error('geen setup');
    const s = await seed();
    const jaar = Number(s.jaarS);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');

    await betalingService.registreer(
      s.vveId,
      {
        datum: `${s.jaarS}-01-05`,
        bedragCent: notaRij.bedragCent,
        bron: 'bank',
        wooneenheidId: s.eenheidId,
        koppelingen: [{ notaId: notaRij.id, bedragCent: notaRij.bedragCent }],
      },
      s.persoonId,
    );

    const analyse = await service.ouderdomsanalyse(s.vveId, `${s.jaarS}-03-15`);
    expect(analyse.totaalCenten).toBe(0);
    expect(analyse.dagen31Tot60).toBe(0);
  });
});
