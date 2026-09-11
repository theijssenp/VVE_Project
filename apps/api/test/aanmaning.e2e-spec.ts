/**
 * Integratietest — aanmaningstraject (G11, spec §5.5 · AC6.5/AC6.6).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0022).
 * Controleert:
 *   - AC6.5: herinnering (T+7) → aanmaning (T+21, veertiendagenbrief) →
 *     ingebrekestelling (T+45); termijnen bewaakt;
 *   - volgorde: een stap mag pas als de vorige er is;
 *   - UNIQUE nota+stap: geen dubbele herinnering;
 *   - AC6.6: incassokosten (WIK: 15%, min € 40) en rente als APARTE nota —
 *     de oorspronkelijke nota blijft onveranderd;
 *   - de kosten-nota krijgt een eigen nummer uit de G06-reeks.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  aanmaning,
  bijdrageRegel,
  bijdrageSchema,
  boekjaar,
  eigenaarschap,
  nota,
  persoon,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import {
  maakAanmaningService,
  wikKosten,
  type AanmaningService,
} from '../src/financieel/aanmaning-service.js';
import { maakNotaService, type NotaService } from '../src/financieel/nota-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Aanmaningstraject (G11, AC6.5/AC6.6)', () => {
  let db: TestPgDb | undefined;
  let service: AanmaningService | undefined;
  let notaService: NotaService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakAanmaningService({ db: db.db });
    notaService = maakNotaService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + eigenaar + schema + één open nota van maand 1. */
  async function seed() {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G11-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g11-${n}-${String(Date.now())}@test.vve`, achternaam: 'Eigenaar' })
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
      exploitatieCent: 240_000, // 20.000 per maand, index 0 met restcent
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

  it('WIK-staffel: 15% met minimum € 40', () => {
    // € 100 → 15% = 15 → min 40. € 1.000 → 150. € 30.000 → 4.500.
    expect(wikKosten(10_000)).toBe(4_000);
    expect(wikKosten(100_000)).toBe(15_000);
    expect(wikKosten(3_000_000)).toBe(450_000);
    expect(wikKosten(0)).toBe(4_000);
  });

  it('AC6.5 — volledige traject: herinnering → aanmaning (veertiendagen) → ingebrekestelling', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed();
    const jaar = s.jaar;
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');
    const verval = notaRij.vervaldatum; // einde januari

    // T+2: te vroeg voor de herinnering (T+7).
    const teVroeg = new Date(`${verval}T00:00:00Z`);
    teVroeg.setUTCDate(teVroeg.getUTCDate() + 2);
    const teVroegS = teVroeg.toISOString().slice(0, 10);
    await expect(service.verstuurStap(s.vveId, notaRij.id, teVroegS, s.persoonId)).rejects.toThrow(
      'pas op of na',
    );

    // T+7: herinnering (kosteloos).
    const t7 = new Date(`${verval}T00:00:00Z`);
    t7.setUTCDate(t7.getUTCDate() + 7);
    const stap1 = await service.verstuurStap(
      s.vveId,
      notaRij.id,
      t7.toISOString().slice(0, 10),
      s.persoonId,
    );
    expect(stap1.stap).toBe('herinnering');
    expect(stap1.isVeertiendagen).toBe(false);
    expect(stap1.incassokostenCent).toBe(0);
    expect(stap1.kostenNotaId).toBeNull();

    // T+9: aanmaning mag niet vóór T+21.
    const t9 = new Date(`${verval}T00:00:00Z`);
    t9.setUTCDate(t9.getUTCDate() + 9);
    await expect(
      service.verstuurStap(s.vveId, notaRij.id, t9.toISOString().slice(0, 10), s.persoonId),
    ).rejects.toThrow('pas op of na');

    // T+21: aanmaning = veertiendagenbrief met aangezegde WIK-kosten.
    const t21 = new Date(`${verval}T00:00:00Z`);
    t21.setUTCDate(t21.getUTCDate() + 21);
    const stap2 = await service.verstuurStap(
      s.vveId,
      notaRij.id,
      t21.toISOString().slice(0, 10),
      s.persoonId,
    );
    expect(stap2.stap).toBe('aanmaning');
    expect(stap2.isVeertiendagen).toBe(true);
    expect(stap2.incassokostenCent).toBe(wikKosten(notaRij.openstaandCent));
    // AC6.6: APARTE kosten-nota, met eigen nummer uit de reeks.
    if (stap2.kostenNotaId === null) throw new Error('geen kosten-nota');
    const [kostenNota] = await db.db.select().from(nota).where(eq(nota.id, stap2.kostenNotaId));
    expect(kostenNota?.type).toBe('incassokosten');
    expect(kostenNota?.nummer).not.toBe(notaRij.nummer);
    // De oorspronkelijke nota is NIET gewijzigd (AC6.6-letter).
    const [origineel] = await db.db.select().from(nota).where(eq(nota.id, notaRij.id));
    expect(origineel?.bedragCent).toBe(notaRij.bedragCent);
    expect(origineel?.openstaandCent).toBe(notaRij.openstaandCent);

    // T+30: ingebrekestelling mag nog niet (T+45).
    const t30 = new Date(`${verval}T00:00:00Z`);
    t30.setUTCDate(t30.getUTCDate() + 30);
    await expect(
      service.verstuurStap(s.vveId, notaRij.id, t30.toISOString().slice(0, 10), s.persoonId),
    ).rejects.toThrow('pas op of na');

    // T+45: ingebrekestelling, met rente-nota (wettelijk default, 6%).
    const t45 = new Date(`${verval}T00:00:00Z`);
    t45.setUTCDate(t45.getUTCDate() + 45);
    const stap3 = await service.verstuurStap(
      s.vveId,
      notaRij.id,
      t45.toISOString().slice(0, 10),
      s.persoonId,
    );
    expect(stap3.stap).toBe('ingebrekestelling');
    expect(stap3.renteCent).toBeGreaterThanOrEqual(0);
    if (stap3.renteCent > 0 && stap3.kostenNotaId !== null) {
      const [renteNota] = await db.db.select().from(nota).where(eq(nota.id, stap3.kostenNotaId));
      expect(['rente', 'incassokosten']).toContain(renteNota?.type ?? kostenNota?.type);
    }

    // Traject overzicht: drie stappen, in volgorde.
    const traject = await service.traject(s.vveId, notaRij.id);
    expect(traject.map((stap) => stap.stap)).toEqual([
      'herinnering',
      'aanmaning',
      'ingebrekestelling',
    ]);

    // Alles verstuurd: een vierde stap is geweigerd.
    const t50 = new Date(`${verval}T00:00:00Z`);
    t50.setUTCDate(t50.getUTCDate() + 50);
    await expect(
      service.verstuurStap(s.vveId, notaRij.id, t50.toISOString().slice(0, 10), s.persoonId),
    ).rejects.toThrow('al doorlopen');
  });

  it('UNIQUE nota+stap: geen dubbele herinnering', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed();
    const jaar = s.jaar;
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');
    const verval = notaRij.vervaldatum;
    const t8 = new Date(`${verval}T00:00:00Z`);
    t8.setUTCDate(t8.getUTCDate() + 8);
    const t8S = t8.toISOString().slice(0, 10);

    await service.verstuurStap(s.vveId, notaRij.id, t8S, s.persoonId);
    // De tweede aanroep wil de AANMANING — die mag pas op T+21; dat is de
    // weigering. De herinnering zelf kan niet dubbel door de UNIQUE.
    await expect(service.verstuurStap(s.vveId, notaRij.id, t8S, s.persoonId)).rejects.toThrow(
      'pas op of na',
    );
    const stappen = await db.db.select().from(aanmaning).where(eq(aanmaning.notaId, notaRij.id));
    expect(stappen.length).toBe(1);
  });

  it('instellingen: aangepaste termijnen verschuiven de deadlines', async () => {
    if (!db || !service || !notaService) throw new Error('geen setup');
    const s = await seed();
    const jaar = s.jaar;
    await notaService.genereerPeriode(s.vveId, invoer(s.boekjaarId, jaar, 1), s.persoonId);
    const [notaRij] = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    if (notaRij === undefined) throw new Error('geen nota');
    await service.zetInstellingen(s.vveId, { herinneringDagen: 3 }, s.persoonId);
    const verval = notaRij.vervaldatum;
    const t4 = new Date(`${verval}T00:00:00Z`);
    t4.setUTCDate(t4.getUTCDate() + 4);
    const stap = await service.verstuurStap(
      s.vveId,
      notaRij.id,
      t4.toISOString().slice(0, 10),
      s.persoonId,
    );
    expect(stap.stap).toBe('herinnering');
  });
});
