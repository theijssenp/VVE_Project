/**
 * Integratietest — nota-PDF en verzending (G07, spec §6.6 · M13 ·
 * AC13.4/AC13.5).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0020).
 * Controleert:
 *   - de PDF is een geldig document (%PDF-kop, %%EOF, xref) met het
 *     betalingskenmerk en het totaal in de inhoudsstroom;
 *   - bouwEnBewaar koppelt het document op de nota (AC13.5);
 *   - AC13.4: serie-verzending stuurt nota's met e-mail via de wachtrij en
 *     rapporteert de eenheden zonder e-mail als postlijst;
 *   - een tweede serie-verzending is leeg (geen dubbelt).
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bijdrageRegel,
  bijdrageSchema,
  boekjaar,
  eigenaarschap,
  mailWachtrij,
  nota,
  persoon,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { maakNotaService, type NotaService } from '../src/financieel/nota-service.js';
import {
  maakNotaVerzendService,
  type NotaVerzendService,
} from '../src/financieel/nota-verzend-service.js';
import { maakMailService, type MailVerzender } from '../src/gemeenschappelijk/mail/mail-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

/** De stille verzender van de test: telt aanroepen, verstuurt niets. */
class StilVerzender implements MailVerzender {
  verzend(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Nota-verzending (G07, AC13.4/AC13.5)', () => {
  let db: TestPgDb | undefined;
  let service: NotaService | undefined;
  let verzend: NotaVerzendService | undefined;
  let mailService: ReturnType<typeof maakMailService> | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakNotaService({ db: db.db });
    mailService = maakMailService({ db: db.db, verzender: new StilVerzender() });
    verzend = maakNotaVerzendService({ db: db.db, mail: mailService });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + twee eigenaren (één met, één zonder e-mail) + schema + nota's. */
  async function seed() {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G07-VvE-${n}` })
      .returning({ id: vve.id });
    const [pMet] = await db.db
      .insert(persoon)
      .values({ email: `g07-${n}-met-${String(Date.now())}@test.vve`, achternaam: 'MetMail' })
      .returning({ id: persoon.id, email: persoon.email });
    const [pZonder] = await db.db
      .insert(persoon)
      .values({
        email: `g07-${n}-zonder-${String(Date.now())}@post.vve`,
        achternaam: 'ZonderMail',
        // De "post"-eenheid: communicatie_wijze 'post' — de VvE mailt deze
        // eigenaar niet (AC13.4); persoon.email blijft gewoon gevuld.
        communicatieWijze: 'post',
      })
      .returning({ id: persoon.id });
    if (v === undefined || pMet === undefined || pZonder === undefined) {
      throw new Error('seed faalde');
    }

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

    const perEenheid = [
      { code: 'A-01', exploitatie: 120_000, reserve: 0, debiteur: pMet.id },
      { code: 'A-02', exploitatie: 120_000, reserve: 0, debiteur: pZonder.id },
    ];
    const eenheidIds: bigint[] = [];
    for (const r of perEenheid) {
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
        persoonId: r.debiteur,
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
      persoonId: pMet.id,
      boekjaarId: jaarRij.id,
      jaar: Number(jaarNummer),
      eenheidCodes: perEenheid.map((r) => r.code),
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

  it('bouwt een leesbare PDF en koppelt haar op de nota (AC13.5)', async () => {
    if (!db || !service || !verzend) throw new Error('geen setup');
    const s = await seed();
    const gen = await service.genereerPeriode(
      s.vveId,
      invoer(s.boekjaarId, s.jaar, 1),
      s.persoonId,
    );
    expect(gen.aantal).toBe(2);

    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    const eerste = rijen[0];
    if (eerste === undefined) throw new Error('geen nota');

    const { id: docId } = await verzend.bouwEnBewaar(s.vveId, eerste.id, s.persoonId);
    expect(docId).toBeGreaterThan(0n);

    const [nagelezen] = await db.db.select().from(nota).where(eq(nota.id, eerste.id));
    expect(nagelezen?.pdfDocumentId).toBe(docId);

    const { bytes, bestandsnaam } = await verzend.leverPdf(s.vveId, eerste.id);
    expect(bestandsnaam).toBe(`nota-${eerste.nummer}.pdf`);
    const tekst = bytes.toString('latin1');
    expect(tekst.startsWith('%PDF-1.4')).toBe(true);
    expect(tekst.endsWith('%%EOF')).toBe(true);
    expect(tekst).toContain(`Betalingskenmerk: ${eerste.betalingskenmerk}`);
    expect(tekst).toContain('Totaal te betalen');
    // De vervaldatum en het nummer staan erin (bewijsstuk-inhoud).
    expect(tekst).toContain(`Nota ${eerste.nummer}`);
    expect(tekst).toContain(`Vervaldatum ${eerste.vervaldatum}`);
  });

  it('AC13.4 — serie-verzending: e-mail naar de wachtrij, postlijst voor de rest', async () => {
    if (!db || !service || !verzend) throw new Error('geen setup');
    const s = await seed();
    const periode = invoer(s.boekjaarId, s.jaar, 1);
    await service.genereerPeriode(s.vveId, periode, s.persoonId);

    const uitkomst = await verzend.verzendSerie(s.vveId, periode.periodeVan, s.persoonId);
    // A-01 heeft e-mail (via de wachtrij), A-02 niet (per post).
    expect(uitkomst.aantalVerzonden).toBe(1);
    expect(uitkomst.aantalPost).toBe(1);
    expect(uitkomst.postlijst).toEqual(['A-02']);

    // Er zit één wachtrij-bericht in, met het bijlagepad van de nota-PDF.
    const berichten = await db.db
      .select()
      .from(mailWachtrij)
      .where(eq(mailWachtrij.vveId, s.vveId));
    expect(berichten.length).toBe(1);
    expect(berichten[0]?.onderwerp).toContain('Nota 20');
    expect(berichten[0]?.bijlagePad).toContain('.pdf');

    // Beide nota's zijn gemarkeerd (verzonden_op gezet) en hebben een PDF.
    const rijen = await db.db.select().from(nota).where(eq(nota.vveId, s.vveId));
    for (const r of rijen) {
      expect(r.verzondenOp).not.toBeNull();
      expect(r.pdfDocumentId).not.toBeNull();
    }
  });

  it('tweede serie-verzending: geen dubbelt (verzonden_op bewaakt)', async () => {
    if (!db || !service || !verzend) throw new Error('geen setup');
    const s = await seed();
    const periode = invoer(s.boekjaarId, s.jaar, 1);
    await service.genereerPeriode(s.vveId, periode, s.persoonId);

    const eerste = await verzend.verzendSerie(s.vveId, periode.periodeVan, s.persoonId);
    expect(eerste.aantalVerzonden + eerste.aantalPost).toBe(2);
    const tweede = await verzend.verzendSerie(s.vveId, periode.periodeVan, s.persoonId);
    expect(tweede.aantalVerzonden).toBe(0);
    expect(tweede.aantalPost).toBe(0);
    const berichten = await db.db
      .select()
      .from(mailWachtrij)
      .where(eq(mailWachtrij.vveId, s.vveId));
    expect(berichten.length).toBe(1); // de tweede run voegde niets toe
  });
});
