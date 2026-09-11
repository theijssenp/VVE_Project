/**
 * Integratietest — betalingen (G08, spec §6.6 · AC6.3 · tests #8–#9).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0021).
 * Controleert:
 *   - test #8: deelbetaling zet de nota op `deels_betaald` met het juiste
 *     openstaande bedrag;
 *   - test #9: vooruitbetaling levert een creditsaldo dat automatisch met
 *     de volgende nota verrekend wordt;
 *   - volledige betaling → `betaald`, openstaand 0;
 *   - overkoppeling (meer koppelen dan openstaand) wordt geweigerd;
 *   - meerdere nota's in één betaling (AC6.3: "één of meer nota's").
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  betaling,
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
import { maakNotaService, type NotaService } from '../src/financieel/nota-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Betalingen (G08, AC6.3 · tests #8–#9)', () => {
  let db: TestPgDb | undefined;
  let service: BetalingService | undefined;
  let notaService: NotaService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakBetalingService({ db: db.db });
    notaService = maakNotaService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + eigenaar + schema met vaste maandbedragen + nota's van maand 1. */
  async function seed(regels: readonly { code: string; exploitatie: number; reserve: number }[]) {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G08-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g08-${n}-${String(Date.now())}@test.vve`, achternaam: 'Eigenaar' })
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
      jaar: Number(jaarNummer),
      jaarS: jaarNummer,
      eenheidIds,
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

  it('test #8 — deelbetaling zet de nota op deels_betaald met het juiste openstaande', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 100_000, reserve: 0 }]);
    const gen = await notaService.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 1),
      s.persoonId,
    );
    expect(gen.aantal).toBe(1);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');

    // Deelbetaling: 60.000 van 10.000 (jan-index: 100.000/12 = 8.334, rest
    // in de eerste perioden — hier exact 8.334; betaal 4.000).
    await service.registreer(
      s.vveId,
      {
        datum: `${s.jaarS}-01-15`,
        bedragCent: 4_000,
        bron: 'handmatig',
        wooneenheidId: s.eenheidIds[0] ?? 0n,
        koppelingen: [{ notaId: notaRij.id, bedragCent: 4_000 }],
        omschrijving: 'Deelbetaling januari',
      },
      s.persoonId,
    );

    const [naBetaling] = await db.db.select().from(nota).where(eq(nota.id, notaRij.id));
    if (naBetaling === undefined) throw new Error('geen nota na betaling');
    expect(naBetaling.status).toBe('deels_betaald');
    expect(naBetaling.openstaandCent).toBe(naBetaling.bedragCent - 4_000);

    // Het creditsaldo blijft 0 (alles gekoppeld).
    const saldo = await service.creditsaldo(s.vveId, s.eenheidIds[0] ?? 0n);
    expect(saldo).toBe(0);
  });

  it('test #9 — vooruitbetaling: creditsaldo verrekent met de volgende nota', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 240_000, reserve: 0 }]);
    // Eerst een betaling zonder open nota's? Nee — de spec wil: betaal méér
    // dan de openstaande nota, het restje wordt creditsaldo. Maand 1 nota is
    // 24.000/12 = 20.000 cent (rest 6 in eerste 4 maanden: index 0 → 20.001).
    const gen = await notaService.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 1),
      s.persoonId,
    );
    expect(gen.aantal).toBe(1);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');

    // Betaal de januari-nota volledig PLUS 30.000 extra (vooruitbetaald).
    const volledig = notaRij.bedragCent;
    const uitkomst = await service.registreer(
      s.vveId,
      {
        datum: `${s.jaarS}-01-05`,
        bedragCent: volledig + 30_000,
        bron: 'bank',
        wooneenheidId: s.eenheidIds[0] ?? 0n,
        koppelingen: [{ notaId: notaRij.id, bedragCent: volledig }],
        omschrijving: 'Volledig + vooruitbetaling februari',
      },
      s.persoonId,
    );
    expect(uitkomst.gekoppeldCenten).toBe(volledig);
    expect(uitkomst.creditsaldoCenten).toBe(30_000);

    const [saldoNa] = await db.db.select().from(nota).where(eq(nota.id, notaRij.id));
    expect(saldoNa?.status).toBe('betaald');
    const saldo = await service.creditsaldo(s.vveId, s.eenheidIds[0] ?? 0n);
    expect(saldo).toBe(30_000);

    // De februari-nota (zelfde bedrag door de verdeling? index 1 = 20.000)
    // verrekent automatisch met het creditsaldo.
    const feb = await notaService.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 2),
      s.persoonId,
    );
    expect(feb.aantal).toBe(1);
    const [febNota] = await db.db
      .select()
      .from(nota)
      .where(eq(nota.periodeVan, invoer(s.boekjaarId, s.jaar, 2).periodeVan));
    if (febNota === undefined) throw new Error('geen februari-nota');
    // De verwerking: 30.000 saldo tegen 20.000 nota → nota betaald.
    expect(febNota.status).toBe('betaald');
    expect(febNota.openstaandCent).toBe(0);
    // Er is een verrekening-betaling bijgekomen.
    const betalingen = await db.db.select().from(betaling).where(eq(betaling.vveId, s.vveId));
    const verrekening = betalingen.find((b) => b.bron === 'verrekening');
    expect(verrekening?.bedragCent).toBe(febNota.bedragCent);
  });

  it('volledige betaling: status betaald, openstaand 0; meerdere nota’s in één betaling', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed([
      { code: 'A-01', exploitatie: 100_000, reserve: 0 },
      { code: 'A-02', exploitatie: 100_000, reserve: 0 },
    ]);
    // Twee nota's voor dezelfde eenheid? Nee — twee eenheden; koppel
    // één betaling over de nota van A-01 en die van A-02 (AC6.3: "één of meer").
    const gen = await notaService.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 1),
      s.persoonId,
    );
    expect(gen.aantal).toBe(2);
    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    const nA = rijen.find((r) => r.wooneenheidId === s.eenheidIds[0]);
    const nB = rijen.find((r) => r.wooneenheidId === s.eenheidIds[1]);
    if (nA === undefined || nB === undefined) throw new Error('nota’s ontbreken');

    await service.registreer(
      s.vveId,
      {
        datum: `${s.jaarS}-01-10`,
        bedragCent: nA.bedragCent + nB.bedragCent,
        bron: 'bank',
        wooneenheidId: s.eenheidIds[0] ?? 0n,
        koppelingen: [
          { notaId: nA.id, bedragCent: nA.bedragCent },
          { notaId: nB.id, bedragCent: nB.bedragCent },
        ],
      },
      s.persoonId,
    );
    const na = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    for (const r of na) {
      expect(r.status).toBe('betaald');
      expect(r.openstaandCent).toBe(0);
    }
  });

  it('weigert overkoppeling: meer koppelen dan de nota openstaat', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed([{ code: 'A-01', exploitatie: 100_000, reserve: 0 }]);
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, s.jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');
    await expect(
      service.registreer(
        s.vveId,
        {
          datum: `${s.jaarS}-01-15`,
          bedragCent: notaRij.bedragCent + 1,
          bron: 'bank',
          wooneenheidId: s.eenheidIds[0] ?? 0n,
          koppelingen: [{ notaId: notaRij.id, bedragCent: notaRij.bedragCent + 1 }],
        },
        s.persoonId,
      ),
    ).rejects.toThrow('overstijgt');
    // De nota is onveranderd gebleven.
    const [rij] = await db.db.select().from(nota).where(eq(nota.id, notaRij.id));
    expect(rij?.status).toBe('open');
    expect(rij?.openstaandCent).toBe(rij?.bedragCent);
  });
});
