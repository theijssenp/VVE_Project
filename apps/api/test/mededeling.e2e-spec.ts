/**
 * Integratietest — mededelingen en mailsjablonen (A06, spec M13 ·
 * AC13.1/AC13.3).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0024).
 * Controleert:
 *   - AC13.1: publiceren met doelgroep en optionele mail via de wachtrij;
 *     de eigenaren-doelgroep filtert live op eigenaarschap;
 *   - AC13.3: het sjabloon valt terug op de standaard (isDefault) en het
 *     zetten ervan werkt create-or-update;
 *   - de laatste-mededelingen-lijst sorteert op publicatiemoment.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  eigenaarschap,
  mailWachtrij,
  mededeling,
  persoon,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import {
  maakMededelingService,
  type MededelingService,
} from '../src/financieel/mededeling-service.js';
import { maakMailService, type MailVerzender } from '../src/gemeenschappelijk/mail/mail-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

/** De stille verzender van de test. */
class StilVerzender implements MailVerzender {
  verzend(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Mededelingen en sjablonen (A06, AC13.1/AC13.3)', () => {
  let db: TestPgDb | undefined;
  let service: MededelingService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    const verzender = new StilVerzender();
    const mail = maakMailService({ db: db.db, verzender });
    service = maakMededelingService({ db: db.db, mail });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + twee personen (één eigenaar van A-01, één zonder). */
  async function seed() {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `A06-VvE-${n}` })
      .returning({ id: vve.id });
    const [pEigenaar] = await db.db
      .insert(persoon)
      .values({ email: `a06-${n}-e-${String(Date.now())}@test.vve`, achternaam: 'Eigenaar' })
      .returning({ id: persoon.id });
    const [pAndere] = await db.db
      .insert(persoon)
      .values({ email: `a06-${n}-a-${String(Date.now())}@test.vve`, achternaam: 'Andere' })
      .returning({ id: persoon.id });
    if (v === undefined || pEigenaar === undefined || pAndere === undefined) {
      throw new Error('seed faalde');
    }
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
      persoonId: pEigenaar.id,
      isPrimairContact: true,
      periode: '[2026-01-01,2026-12-31]',
    });
    return { vveId: v.id, persoonId: pEigenaar.id, andereId: pAndere.id, eenheidId: e.id };
  }

  it('AC13.1 — publiceren met doelgroep eigenaren stuurt alleen aan die groep', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    const uitkomst = await service.publiceer(
      s.vveId,
      {
        titel: 'Lift-onderhoud gepland',
        inhoud: 'De lift is op 15 maart buiten dienst tussen 8:00 en 12:00.',
        doelgroep: 'eigenaren',
        verzendMail: true,
      },
      s.persoonId,
    );
    expect(uitkomst.id).toBeGreaterThan(0n);
    // A-01 heeft één eigenaar; de 'andere' persoon hoort niet bij de VvE.
    expect(uitkomst.aantalMail).toBe(1);

    const berichten = await db.db
      .select()
      .from(mailWachtrij)
      .where(eq(mailWachtrij.vveId, s.vveId));
    expect(berichten.length).toBe(1);
    expect(berichten[0]?.onderwerp).toBe('Lift-onderhoud gepland');

    const [rij] = await db.db.select().from(mededeling).where(eq(mededeling.id, uitkomst.id));
    expect(rij?.mailVerzonden).toBe(true);
    expect(rij?.doelgroep).toBe('eigenaren');
  });

  it('publiceren zonder mail: niets in de wachtrij, vlag false', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const uitkomst = await service.publiceer(
      s.vveId,
      {
        titel: 'Algemene vergadering aangekondigd',
        inhoud: 'De ALV is op 1 april in het gemeenschappelijke trappenhuis.',
        doelgroep: 'alle_leden',
        verzendMail: false,
      },
      s.persoonId,
    );
    expect(uitkomst.aantalMail).toBe(0);
    const [rij] = await db.db.select().from(mededeling).where(eq(mededeling.id, uitkomst.id));
    expect(rij?.mailVerzonden).toBe(false);
    const berichten = await db.db
      .select()
      .from(mailWachtrij)
      .where(eq(mailWachtrij.vveId, s.vveId));
    expect(berichten.length).toBe(0);
  });

  it('AC13.3 — sjabloon: fallback naar standaard, dan create-or-update', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    // Zonder rij: het standaardsjabloon (AC13.3-fallback).
    const standaard = await service.sjabloon(s.vveId);
    expect(standaard.isDefault).toBe(true);
    expect(standaard.afzendernaam).toBe('De VvE');

    // Zetten en teruglezen.
    await service.zetSjabloon(
      s.vveId,
      { afzendernaam: 'Bestuur VvE De Toren', ondertekening: 'Namens het bestuur' },
      s.persoonId,
    );
    const gewijzigd = await service.sjabloon(s.vveId);
    expect(gewijzigd.isDefault).toBe(false);
    expect(gewijzigd.afzendernaam).toBe('Bestuur VvE De Toren');

    // Opnieuw zetten = update, geen tweede rij.
    await service.zetSjabloon(s.vveId, { afzendernaam: 'Bestuur VvE De Toren v2' }, s.persoonId);
    const sjablonen = await db.db
      .select()
      .from((await import('../src/database/schema/mededeling.js')).mailSjabloon);
    expect(sjablonen.length).toBe(1);
  });

  it('laatste-medeedelingen: gesorteerd op publicatiemoment, nieuwste eerst', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    await service.publiceer(
      s.vveId,
      { titel: 'Eerste', inhoud: 'a', doelgroep: 'alle_leden', verzendMail: false },
      s.persoonId,
    );
    await service.publiceer(
      s.vveId,
      { titel: 'Tweede', inhoud: 'b', doelgroep: 'alle_leden', verzendMail: false },
      s.persoonId,
    );
    const rijen = await service.laatste(s.vveId, 10);
    expect(rijen.length).toBe(2);
    expect(rijen[0]?.titel).toBe('Tweede');
    expect(rijen[1]?.titel).toBe('Eerste');
  });
});
