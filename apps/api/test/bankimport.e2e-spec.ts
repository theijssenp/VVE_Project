/**
 * Integratietest — bankimport CAMT.053 (B02, AC7.1–7.3, tests #11–12).
 *
 * Test #11: hetzelfde bestand twee keer importeren voegt 0 nieuwe transacties
 * toe. Dat is hier een databasegarantie (UNIQUE op vve_id + hash) en geen
 * controle in code; de test bewijst het door werkelijk twee keer te importeren.
 *
 * Test #12: saldodiscontinuïteit tussen twee opeenvolgende bestanden wordt
 * gedetecteerd en gemeld, met het gat erbij.
 *
 * Daarnaast: tegenrekeningen gaan versleuteld de database in (§6.2) — dat is de
 * reden dat B01 vóór B02 moest.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bankmutatie, bankrekening, persoon, vve } from '../src/database/schema/index.js';
import {
  beveiligIban,
  laadIbanSleutels,
  type IbanSleutels,
} from '../src/bank/iban-versleuteling.js';
import { maakBankimportService, type BankimportService } from '../src/bank/bankimport-service.js';
import { NietGevondenFout } from '../src/financieel/boekhouding.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

const hier = dirname(fileURLToPath(import.meta.url));
const voorbeeld = readFileSync(
  join(
    hier,
    '..',
    '..',
    '..',
    'packages',
    'domein',
    'src',
    'bank',
    'fixtures',
    'camt053-voorbeeld.xml',
  ),
  'utf8',
);

const EIGEN_IBAN = 'NL02ABNA0123456789';

/**
 * Vervangt het begin- en eindsaldo van het afschrift. De twee `Bal`-blokken
 * staan in vaste volgorde (OPBD, dan CLBD); ze los benaderen is leesbaarder
 * dan één regex die beide tegelijk probeert te raken.
 */
function zetSaldi(xml: string, begin: string, eind: string): string {
  const blokken = xml.split('<Bal>');
  if (blokken.length < 3) throw new Error('fixture heeft geen twee saldoblokken');
  const vervang = (blok: string, bedrag: string): string =>
    blok.replace(/<Amt Ccy="EUR">[\d.]+<\/Amt>/, `<Amt Ccy="EUR">${bedrag}</Amt>`);
  blokken[1] = vervang(blokken[1] ?? '', begin);
  blokken[2] = vervang(blokken[2] ?? '', eind);
  return blokken.join('<Bal>');
}

describe('Bankimport (B02, tests #11–12)', () => {
  let db: TestPgDb | undefined;
  let dienst: BankimportService | undefined;
  let sleutels: IbanSleutels | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    // Vaste testsleutels; de echte komen uit de omgeving (§8.2).
    process.env['IBAN_VERSLEUTEL_SLEUTEL'] = 'b'.repeat(64); // hex, 32 bytes
    process.env['IBAN_HMAC_SLEUTEL'] = 'c'.repeat(64);
    sleutels = laadIbanSleutels();
    dienst = maakBankimportService({ db: db.db, sleutels });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seed(): Promise<{ vveId: bigint; persoonId: bigint; rekeningId: bigint }> {
    if (!db || !sleutels) throw new Error('geen setup');
    teller += 1;
    const n = `${String(teller)}-${String(process.pid)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B02-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b02-${n}@test.vve`, achternaam: 'Bank' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    const drieluik = beveiligIban(EIGEN_IBAN, sleutels);
    const [r] = await db.db
      .insert(bankrekening)
      .values({
        vveId: v.id,
        naam: 'Betaalrekening',
        ibanVersleuteld: drieluik.versleuteld,
        ibanHmac: drieluik.hmac,
        ibanMasker: drieluik.masker,
        sleutelVersie: drieluik.sleutelVersie,
      })
      .returning({ id: bankrekening.id });
    if (r === undefined) throw new Error('rekening faalde');
    return { vveId: v.id, persoonId: p.id, rekeningId: r.id };
  }

  it('leest het afschrift in en bewaart de posten', async () => {
    if (!dienst) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const [uit] = await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);
    if (uit === undefined) throw new Error('geen uitkomst');

    expect(uit.aantalPosten).toBe(3);
    expect(uit.aantalNieuw).toBe(3);
    expect(uit.aantalDuplicaat).toBe(0);
    expect(uit.beginsaldoCent).toBe(150_000);
    expect(uit.eindsaldoCent).toBe(163_750);
    expect(uit.afschriftSluit).toBe(true);
    // Eerste import: er is nog geen vorige stand, dus geen gat.
    expect(uit.continuiteitGatCent).toBeNull();
  });

  it('test #11: hetzelfde bestand twee keer voegt 0 nieuwe transacties toe', async () => {
    if (!db || !dienst) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();

    const [eerste] = await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);
    expect(eerste?.aantalNieuw).toBe(3);

    const [tweede] = await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);
    expect(tweede?.aantalNieuw).toBe(0);
    expect(tweede?.aantalDuplicaat).toBe(3);

    // En in de database staan er werkelijk drie, niet zes.
    const rijen = await db.db
      .select({ id: bankmutatie.id })
      .from(bankmutatie)
      .where(eq(bankmutatie.vveId, vveId));
    expect(rijen).toHaveLength(3);
  });

  it('test #12: een gat in de saldocontinuïteit wordt gedetecteerd en gemeld', async () => {
    if (!dienst) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);

    // Volgend afschrift dat níet op 1637.50 begint maar op 1700.00: er is een
    // dag overgeslagen. Ook de posten krijgen een andere referentie, anders
    // zou de duplicaatdetectie ze al tegenhouden.
    const volgende = voorbeeld
      .replace('<Id>2026031</Id>', '<Id>2026032</Id>')
      .replace('<Amt Ccy="EUR">1500.00</Amt>', '<Amt Ccy="EUR">1700.00</Amt>')
      .replace('<Amt Ccy="EUR">1637.50</Amt>', '<Amt Ccy="EUR">1837.50</Amt>')
      .replace(/<Dt>2026-03-01<\/Dt>/g, '<Dt>2026-03-02</Dt>')
      .replace(/REF-000/g, 'REF-100');

    const [uit] = await dienst.importeerCamt053(vveId, volgende, {}, persoonId);
    // 1700.00 verwacht 1637.50: een gat van 62.50.
    expect(uit?.continuiteitGatCent).toBe(6_250);
    // De import gaat wél door; de posten zijn echt.
    expect(uit?.aantalNieuw).toBe(3);
  });

  it('een aansluitend afschrift meldt geen gat', async () => {
    if (!dienst) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);

    // Het vorige eindsaldo was 1637.50; dit afschrift begint daar precies op
    // en eindigt 137.50 hoger (de som van dezelfde drie posten).
    const volgende = zetSaldi(voorbeeld, '1637.50', '1775.00')
      .replace('<Id>2026031</Id>', '<Id>2026032</Id>')
      .replace(/REF-000/g, 'REF-200');

    const [uit] = await dienst.importeerCamt053(vveId, volgende, {}, persoonId);
    expect(uit?.continuiteitGatCent).toBeNull();
    expect(uit?.afschriftSluit).toBe(true);
  });

  it('§6.2: de tegenrekening staat versleuteld in de database', async () => {
    if (!db || !dienst) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    await dienst.importeerCamt053(vveId, voorbeeld, {}, persoonId);

    const rijen = await db.db
      .select({
        versleuteld: bankmutatie.tegenrekeningVersleuteld,
        masker: bankmutatie.tegenrekeningMasker,
        naam: bankmutatie.tegenpartijNaam,
      })
      .from(bankmutatie)
      .where(and(eq(bankmutatie.vveId, vveId), eq(bankmutatie.volgnummer, 1)));
    const rij = rijen[0];
    if (rij === undefined) throw new Error('geen mutatie');

    expect(rij.versleuteld).not.toBeNull();
    // De platte IBAN komt nergens in de opgeslagen bytes voor.
    expect(rij.versleuteld?.toString('utf8')).not.toContain('NL20INGB0001234567');
    // Het masker is er wél, want daar moet de beheerder op kunnen kijken.
    expect(rij.masker).toContain('NL20');
    expect(rij.naam).toBe('J. de Vries');
  });

  it('een onbekende bankrekening wordt geweigerd, niet stilzwijgend aangemaakt', async () => {
    if (!db || !dienst) throw new Error('geen setup');
    teller += 1;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B02-leeg-${String(teller)}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b02-leeg-${String(teller)}@test.vve`, achternaam: 'Leeg' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');

    await expect(dienst.importeerCamt053(v.id, voorbeeld, {}, p.id)).rejects.toBeInstanceOf(
      NietGevondenFout,
    );
  });
});
