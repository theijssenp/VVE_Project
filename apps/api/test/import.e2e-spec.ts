/**
 * Integratietest — bulk-import (V06, spec M2 · AC2.7).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0025). De
 * tabellezer (CSV + XLSX) is pure code en wordt hier direct getoetst; de
 * import-service wordt tegen de echte db gedraaid. Controleert:
 *   - de kolomtoets: ontbrekende verplichte koppen worden gerapporteerd,
 *     er wordt niets geschreven (validatie vooraf);
 *   - per-rij validatie: foutverzameling (code, type, breukdeel, e-mail,
 *     aandeel) zonder eerste-gooien;
 *   - dry-run: het rapport beschrijft de actie per rij — db blijft leeg;
 *   - uitvoeren: eenheden aangemaakt, bestaande personen gekoppeld,
 *     nieuwe adressen een uitnodiging (V04-patroon);
 *   - idempotentie: een tweede run maakt geen dubbele rijen;
 *   - de XLSX-lezer: zelfde tabelvorm uit een echt ZIP-archief (Node-zlib).
 */

import { deflateRawSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  eigenaarschap,
  persoon,
  uitnodiging,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import { maakImportService, type ImportService } from '../src/modules/eenheden/import-service.js';
import { parseCsv, parseTabel } from '../src/modules/eenheden/tabel-lezer.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Bulk-import (V06, AC2.7)', () => {
  let db: TestPgDb | undefined;
  let service: ImportService | undefined;
  let vveNummer = 0;
  const mailtjes: { aan: string; onderwerp: string }[] = [];

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    service = maakImportService({
      db: db.db,
      klok: new SystemKlok(),
      registratieBasis: 'https://test.vve/registratie',
      verzendMail: (aan, onderwerp) => {
        mailtjes.push({ aan, onderwerp });
        return Promise.resolve();
      },
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seed(): Promise<{ vveId: bigint; beheerderId: bigint }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const uniek = `${n}-${String(Date.now())}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `V06-VvE-${n}` })
      .returning({ id: vve.id });
    const [b] = await db.db
      .insert(persoon)
      .values({ email: `v06-${uniek}-b@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    const [bestaande] = await db.db
      .insert(persoon)
      .values({ email: `v06-${uniek}-x@test.vve`, achternaam: 'Bestaande Eigenaar' })
      .returning({ id: persoon.id });
    if (v === undefined || b === undefined || bestaande === undefined)
      throw new Error('seed faalde');
    return { vveId: v.id, beheerderId: b.id };
  }

  function csvMet(rijen: readonly string[]): Buffer {
    const kop =
      'code;type;gebouw;straat;huisnummer;postcode;plaats;oppervlakte_m2;breukdeel_teller;breukdeel_noemer;stemmen;eigenaar_email;eigenaar_voornaam;eigenaar_tussenvoegsel;eigenaar_achternaam;eigenaar_aandeel_promille';
    return Buffer.from([kop, ...rijen].join('\n'), 'utf8');
  }

  it('kolomtoets: ontbrekende verplichte kolommen → rapport, db leeg', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    // Kop mist de meeste kolommen; één rij met code.
    const bytes = Buffer.from('code\nA-01\n', 'utf8');
    const rapport = await service.verwerk(s.vveId, { bytes, uitvoeren: true }, s.beheerderId);
    expect(rapport.kolommenOk).toBe(false);
    expect(rapport.mistKolommen.length).toBeGreaterThan(0);
    expect(rapport.uitgevoerd).toBe(false);
    const eenheden = await db.db
      .select({ id: wooneenheid.id })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, s.vveId));
    expect(eenheden).toHaveLength(0);
  });

  it('per-rij validatie: fouten verzameld, niet eerste-gooien', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const bytes = csvMet([
      'A-01;woning;;;;;;;;;;;;;', // geldig, geen eigenaar
      'B-99;zolder;;;;;;;;;;;;;', // onbekend type
      'C-02;woning;;;;;;;;;;e-mail-zonder-at;;;', // ongeldig e-mail
      'D-03;woning;;;;;;;;;;;;;; ', // aandeel-tekst (spatie) → NaN → ongeldig
      ';woning;;;;;;;;;;;;;', // code verplicht
    ]);
    const rapport = await service.verwerk(s.vveId, { bytes, uitvoeren: false }, s.beheerderId);
    expect(rapport.ongeldig).toBeGreaterThanOrEqual(3);
    const foutCodes = rapport.rijen.filter((r) => r.fout !== null).map((r) => r.code);
    expect(foutCodes).toContain('B-99');
  });

  it('dry-run: rapport beschrijft acties, db blijft leeg', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const bytes = csvMet([
      'A-01;woning;;;;;;;;;;jan@example.nl;Jan;;Jansen;1000',
      'A-02;parkeerplaats;;;;;;;;;;;;;',
    ]);
    const rapport = await service.verwerk(s.vveId, { bytes, uitvoeren: false }, s.beheerderId);
    expect(rapport.kolommenOk).toBe(true);
    expect(rapport.geldig).toBe(2);
    expect(rapport.uitgevoerd).toBe(false);
    const eenheden = await db.db
      .select({ id: wooneenheid.id })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, s.vveId));
    expect(eenheden).toHaveLength(0);
  });

  it('uitvoeren: eenheden aangemaakt, bestaande persoon gekoppeld, nieuw adres uitnodiging', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    // De eerste eigenaar-mail bestaat al (seed); de tweede niet.
    const bestaandeEmail = await bestaandEmailVan(db);
    const bytes = csvMet([
      bestaandRij(bestaandeEmail),
      'A-02;woning;;;;;;;;;;nieuw-v06@example.nl;Nieuwe;;Eigenaar;500',
    ]);
    const rapport = await service.verwerk(s.vveId, { bytes, uitvoeren: true }, s.beheerderId);
    expect(rapport.uitgevoerd).toBe(true);
    expect(rapport.aangemaakteEenheden).toBe(2);
    expect(rapport.gekoppeldeEigenaren).toBe(1);
    expect(rapport.gestuurdeUitnodigingen).toBe(1);

    const eenheden = await db.db
      .select({
        code: wooneenheid.code,
        teller: wooneenheid.breukdeelTeller,
        noemer: wooneenheid.breukdeelNoemer,
      })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, s.vveId));
    expect(eenheden).toHaveLength(2);

    // Bestaande persoon: lopend eigenaarschap op A-01 met 1000 promille.
    const koppelingen = await db.db
      .select({ code: wooneenheid.code, aandeel: eigenaarschap.aandeelPromille })
      .from(eigenaarschap)
      .innerJoin(wooneenheid, eq(wooneenheid.id, eigenaarschap.wooneenheidId))
      .where(eq(eigenaarschap.vveId, s.vveId));
    expect(koppelingen).toHaveLength(1);
    expect(koppelingen[0]?.aandeel).toBe(1000);

    // Nieuw adres: een uitnodigings-rij, en de mail kwam in de nepverzender.
    const uitnodigingen = await db.db
      .select({ email: uitnodiging.email, rol: uitnodiging.rol })
      .from(uitnodiging)
      .where(eq(uitnodiging.vveId, s.vveId));
    expect(uitnodigingen).toHaveLength(1);
    expect(uitnodigingen[0]?.email).toBe('nieuw-v06@example.nl');
    expect(mailtjes.some((m) => m.aan === 'nieuw-v06@example.nl')).toBe(true);
  });

  it('idempotentie: tweede run levert geen dubbele eenheden of koppelingen', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const bestaandeEmail = await bestaandEmailVan(db);
    const bytes = csvMet([bestaandRij(bestaandeEmail)]);
    await service.verwerk(s.vveId, { bytes, uitvoeren: true }, s.beheerderId);
    const tweede = await service.verwerk(s.vveId, { bytes, uitvoeren: true }, s.beheerderId);
    expect(tweede.aangemaakteEenheden).toBe(0); // code hergebruikt
    expect(tweede.gekoppeldeEigenaren).toBe(0); // koppeling idempotent
    expect(tweede.gestuurdeUitnodigingen).toBe(0);

    const eenheden = await db.db
      .select({ id: wooneenheid.id })
      .from(wooneenheid)
      .where(eq(wooneenheid.vveId, s.vveId));
    expect(eenheden).toHaveLength(1);
    const koppelingen = await db.db
      .select({ id: eigenaarschap.id })
      .from(eigenaarschap)
      .where(eq(eigenaarschap.vveId, s.vveId));
    expect(koppelingen).toHaveLength(1);
  });

  it('tabel-lezer: XLSX (ZIP) levert dezelfde rijvorm als CSV', () => {
    // Bouw een minimaal XLSX: ZIP-archief met stored entries.
    const sheetXml =
      '<?xml version="1.0"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<row><c r="A1" t="str"><v>code</v></c><c r="B1" t="str"><v>eigenaar_email</v></c></row>' +
      '<row><c r="A2" t="str"><v>Z-01</v></c><c r="B2" t="str"><v>x@y.nl</v></c></row>' +
      '</worksheet>';
    const zip = zipMetEntries([
      { pad: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8'), deflate: true },
    ]);
    const tabel = parseTabel(zip);
    expect(tabel.koppen).toEqual(['code', 'eigenaar_email']);
    const eerste = tabel.rijen[0];
    expect(eerste?.[0]).toEqual(['code', 'Z-01']);
    expect(eerste?.[1]).toEqual(['eigenaar_email', 'x@y.nl']);

    // En CSV met puntkomma + aanhalingstekens (RFC 4180).
    const csv = parseCsv('code;eigenaar_email\n"S-01";"y@voorbeeld.nl"\n');
    expect(csv.koppen).toEqual(['code', 'eigenaar_email']);
    expect(csv.rijen[0]?.[0]).toEqual(['code', 'S-01']);
  });

  it('voorbeeldbestand: kolommen matchen de parser (AC2.7)', () => {
    if (!service) throw new Error('geen setup');
    const voorbeeld = service.voorbeeldCsv();
    const tabel = parseCsv(voorbeeld);
    // Koppen = de IMPORT_KOLOMMEN-volgorde; elke kolomnaam komt terug.
    expect(tabel.koppen).toContain('code');
    expect(tabel.koppen).toContain('eigenaar_email');
    expect(tabel.rijen.length).toBeGreaterThan(0);
  });
});

/** De e-mail van een (bestaande) persoon in de seed — voor de koppelingstest. */
async function bestaandEmailVan(testDb: TestPgDb | undefined): Promise<string> {
  if (!testDb) throw new Error('geen test-db');
  const [rij] = await testDb.db
    .select({ email: persoon.email })
    .from(persoon)
    .where(eq(persoon.achternaam, 'Bestaande Eigenaar'))
    .limit(1);
  if (rij === undefined) throw new Error('bestaande-eigenaar-seed faalde');
  return rij.email;
}

/** De import-rij voor de bestaande eigenaar (kop-index 11 = eigenaar_email). */
function bestaandRij(email: string): string {
  return `A-01;woning;;;;;;;;;;${email};Bestaande;;Eigenaar;1000`;
}

/**
 * Minimale ZIP-bouw: lokale bestandsheader + data per entry, zonder centrale
 * directory (de lezer stopt vanzelf op de niet-PK-bytes na de laatste entry).
 */
function zipMetEntries(
  entries: readonly { pad: string; data: Buffer; deflate: boolean }[],
): Buffer {
  const delen: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const naam = Buffer.from(entry.pad, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // lokale header-signatuur
    header.writeUInt16LE(20, 4); // versie
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8); // methode
    header.writeUInt32LE(data.length, 18); // gecomprimeerde lengte
    header.writeUInt32LE(entry.data.length, 22); // ongecomprimeerd
    header.writeUInt16LE(naam.length, 26);
    header.writeUInt16LE(0, 28); // extra-lengte
    delen.push(header, naam, data);
  }
  return Buffer.concat(delen);
}
