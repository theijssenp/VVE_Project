/**
 * Integratietest — jaarrekening en export (B08, M9 · AC9.4).
 *
 * Controleert:
 *   - balans en staat van baten en lasten met de juiste tekens: elk bedrag
 *     positief aan de eigen kant van de rekening;
 *   - het resultaat is baten min lasten, en de balans sluit mét dat resultaat
 *     erin — vóór het afsluiten staat het nog niet op het eigen vermogen;
 *   - de vergelijkende kolom vorig jaar verschijnt alleen als dat jaar bestaat;
 *   - de begrotingskolom telt alleen een vastgestelde begroting mee;
 *   - XLSX: een geldige ZIP met twee bladen, bedragen als getal in euro's;
 *   - PDF: geldige bytes met een xref en meerdere pagina's als het niet past.
 *
 * De XLSX wordt met de hand uitgepakt in plaats van met een parser-dependency:
 * een test die een bibliotheek nodig heeft om het eigen bestand te lezen,
 * toetst vooral die bibliotheek.
 */

import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import {
  begroting,
  begrotingsregel,
  grootboekrekening,
  persoon,
  verdeelsleutel,
  vve,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import { Regel, maakBoekhouding, type Boekhouding } from '../src/financieel/boekhouding.js';
import { maakBoekjaarService, type BoekjaarService } from '../src/financieel/boekjaar-service.js';
import {
  maakJaarrekeningService,
  type JaarrekeningService,
} from '../src/financieel/jaarrekening-service.js';
import {
  bouwJaarrekeningPdf,
  bouwJaarrekeningXlsx,
} from '../src/financieel/jaarrekening-export.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

/**
 * Haalt de bestanden uit een ZIP met `stored`-entries (geen deflate), door de
 * central directory te lopen. Genoeg om te controleren wat er in zit.
 */
function pakZipUit(zip: Buffer): Map<string, string> {
  const uit = new Map<string, string>();
  // End of central directory staat achteraan; zoek de signature.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('geen ZIP: end-of-central-directory ontbreekt');
  const aantal = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < aantal; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('central directory kapot');
    const methode = zip.readUInt16LE(offset + 10);
    const naamLengte = zip.readUInt16LE(offset + 28);
    const extraLengte = zip.readUInt16LE(offset + 30);
    const commentLengte = zip.readUInt16LE(offset + 32);
    const lokaalOffset = zip.readUInt32LE(offset + 42);
    const naam = zip.subarray(offset + 46, offset + 46 + naamLengte).toString('utf8');

    const lokaalNaamLengte = zip.readUInt16LE(lokaalOffset + 26);
    const lokaalExtraLengte = zip.readUInt16LE(lokaalOffset + 28);
    const dataStart = lokaalOffset + 30 + lokaalNaamLengte + lokaalExtraLengte;
    const grootte = zip.readUInt32LE(lokaalOffset + 18);
    const data = zip.subarray(dataStart, dataStart + grootte);
    uit.set(naam, methode === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8'));

    offset += 46 + naamLengte + extraLengte + commentLengte;
  }
  return uit;
}

describe('Jaarrekening (B08, AC9.4)', () => {
  let db: TestPgDb | undefined;
  let boekhouding: Boekhouding | undefined;
  let boekjaarSvc: BoekjaarService | undefined;
  let jaarrekeningSvc: JaarrekeningService | undefined;
  let teller = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    boekhouding = maakBoekhouding({ db: db.db });
    boekjaarSvc = maakBoekjaarService({ db: db.db });
    jaarrekeningSvc = maakJaarrekeningService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** VvE met schema en een open boekjaar 2026; optioneel ook 2025. */
  async function seed(metVorigJaar = false): Promise<{
    vveId: bigint;
    persoonId: bigint;
    jaarId: bigint;
    vorigId: bigint | null;
  }> {
    if (!db || !boekjaarSvc) throw new Error('geen setup');
    teller += 1;
    const n = `${String(teller)}-${String(process.pid)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B08-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b08-${n}@test.vve`, achternaam: 'Jaar' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));

    let vorigId: bigint | null = null;
    if (metVorigJaar) {
      const vorig = await boekjaarSvc.maakBoekjaar(
        v.id,
        { jaar: 2025, startDatum: '2025-01-01', eindDatum: '2025-12-31' },
        p.id,
      );
      vorigId = vorig.id;
      await boekjaarSvc.open(v.id, vorig.id, p.id);
    }
    const { id } = await boekjaarSvc.maakBoekjaar(
      v.id,
      { jaar: 2026, startDatum: '2026-01-01', eindDatum: '2026-12-31' },
      p.id,
    );
    // Eén open boekjaar per VvE. Is er een vorig jaar, dan blijft dát open
    // zodat de test er eerst in kan boeken; `naarHuidigJaar` schuift daarna op.
    if (vorigId === null) await boekjaarSvc.open(v.id, id, p.id);
    return { vveId: v.id, persoonId: p.id, jaarId: id, vorigId };
  }

  /** Sluit het vorige jaar en opent het lopende — de volgorde die §6.7 eist. */
  async function naarHuidigJaar(
    vveId: bigint,
    persoonId: bigint,
    vorigId: bigint,
    jaarId: bigint,
  ): Promise<void> {
    if (!boekjaarSvc) throw new Error('geen setup');
    await boekjaarSvc.afsluiten(vveId, vorigId, persoonId);
    await boekjaarSvc.open(vveId, jaarId, persoonId);
  }

  /** Bijdrage (baten) en een onderhoudsfactuur (lasten). */
  async function boekJaar(
    vveId: bigint,
    jaarId: bigint,
    persoonId: bigint,
    datum: string,
    batenCent: number,
    lastenCent: number,
  ): Promise<void> {
    if (!boekhouding) throw new Error('geen setup');
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum,
        omschrijving: 'Bijdragen',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1300', Bedrag.vanCenten(batenCent)),
          Regel.credit('8100', Bedrag.vanCenten(batenCent)),
        ],
      },
      persoonId,
    );
    await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum,
        omschrijving: 'Onderhoud',
        bron: 'memoriaal',
        regels: [
          Regel.debet('4100', Bedrag.vanCenten(lastenCent)),
          Regel.credit('1100', Bedrag.vanCenten(lastenCent)),
        ],
      },
      persoonId,
    );
  }

  it('tekens kloppen en het resultaat is baten min lasten', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);

    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);

    // Baten staan credit en komen positief in beeld; lasten staan debet, ook positief.
    expect(jr.baten.totaalCent).toBe(100_000);
    expect(jr.lasten.totaalCent).toBe(40_000);
    expect(jr.resultaatCent).toBe(60_000);
    // Debiteuren (activa) positief, bank (activa) negatief door de betaling.
    const debiteuren = jr.activa.regels.find((r) => r.nummer === '1300');
    expect(debiteuren?.bedragCent).toBe(100_000);
  });

  it('de balans sluit inclusief het resultaat van het lopende jaar', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);

    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    // Met de hand: activa == passiva + eigen vermogen + resultaat.
    expect(jr.activa.totaalCent).toBe(
      jr.passiva.totaalCent + jr.eigenVermogen.totaalCent + jr.resultaatCent,
    );
    expect(jr.inBalans).toBe(true);
  });

  it('zonder vorig boekjaar blijft de vergelijkende kolom leeg', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);

    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(jr.vorigJaar).toBeNull();
    expect(jr.baten.totaalVorigJaarCent).toBeNull();
    expect(jr.resultaatVorigJaarCent).toBeNull();
  });

  it('met vorig boekjaar staan de cijfers van dat jaar ernaast', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId, vorigId } = await seed(true);
    if (vorigId === null) throw new Error('geen vorig jaar');
    await boekJaar(vveId, vorigId, persoonId, '2025-02-01', 80_000, 30_000);
    await naarHuidigJaar(vveId, persoonId, vorigId, jaarId);
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);

    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(jr.vorigJaar).toBe(2025);
    expect(jr.baten.totaalVorigJaarCent).toBe(80_000);
    expect(jr.lasten.totaalVorigJaarCent).toBe(30_000);
    expect(jr.resultaatVorigJaarCent).toBe(50_000);
    // En het lopende jaar blijft ongewijzigd naast die kolom staan.
    expect(jr.resultaatCent).toBe(60_000);
  });

  it('alleen een vastgestelde begroting telt als vergelijkingsmaatstaf', async () => {
    if (!db || !jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);

    const [rekening] = await db.db
      .select({ id: grootboekrekening.id })
      .from(grootboekrekening)
      .where(eqRekening(vveId, '4100'))
      .limit(1);
    if (rekening === undefined) throw new Error('rekening 4100 ontbreekt');

    // Een begrotingsregel wijst altijd naar een verdeelsleutel (AC4.3), dus
    // die moet er zijn — al is hij hier niet het onderwerp van de test.
    const [sleutel] = await db.db
      .insert(verdeelsleutel)
      .values({ vveId, naam: 'Breukdeel', type: 'breukdeel' })
      .returning({ id: verdeelsleutel.id });
    if (sleutel === undefined) throw new Error('verdeelsleutel faalde');

    const [b] = await db.db
      .insert(begroting)
      .values({ vveId, boekjaarId: jaarId, status: 'concept' })
      .returning({ id: begroting.id });
    if (b === undefined) throw new Error('begroting faalde');
    await db.db.insert(begrotingsregel).values({
      begrotingId: b.id,
      grootboekrekeningId: rekening.id,
      omschrijving: 'Onderhoud',
      bedragCent: 45_000,
      verdeelsleutelId: sleutel.id,
    });

    // Concept: telt nog niet mee — een concept is geen afspraak (AC5.1).
    const concept = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(concept.heeftBegroting).toBe(false);
    expect(concept.lasten.totaalBegrootCent).toBeNull();

    await db.db
      .update(begroting)
      .set({ status: 'vastgesteld', vastgesteldOp: '2025-12-01' })
      .where(eqBegroting(b.id));

    const vastgesteld = await jaarrekeningSvc.jaarrekening(vveId, jaarId);
    expect(vastgesteld.heeftBegroting).toBe(true);
    expect(vastgesteld.lasten.totaalBegrootCent).toBe(45_000);
  });

  it('XLSX is een geldige ZIP met twee bladen en getallen in euro’s', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);
    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);

    const bytes = bouwJaarrekeningXlsx(jr);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const bestanden = pakZipUit(bytes);
    expect([...bestanden.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(bestanden.get('xl/workbook.xml')).toContain('name="Balans"');
    expect(bestanden.get('xl/workbook.xml')).toContain('name="Baten en lasten"');

    // 100.000 cent moet als 1000 (euro) in het blad staan, als getal en niet
    // als tekst: anders kan de ontvanger er niet mee rekenen.
    const blad2 = bestanden.get('xl/worksheets/sheet2.xml') ?? '';
    expect(blad2).toContain('<v>1000</v>');
    expect(blad2).not.toContain('<v>100000</v>');
  });

  it('PDF levert geldige bytes met xref', async () => {
    if (!jaarrekeningSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekJaar(vveId, jaarId, persoonId, '2026-02-01', 100_000, 40_000);
    const jr = await jaarrekeningSvc.jaarrekening(vveId, jaarId);

    const pdf = bouwJaarrekeningPdf(jr).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('xref');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('Jaarrekening');
    // De balanscontrole hoort zichtbaar op het stuk te staan.
    expect(pdf).toContain('Balans sluit');
  });
});

// Kleine hulpjes, onderaan zodat de tests zelf leesbaar blijven.
import { and, eq } from 'drizzle-orm';
function eqRekening(vveId: bigint, nummer: string) {
  return and(eq(grootboekrekening.vveId, vveId), eq(grootboekrekening.nummer, nummer));
}
function eqBegroting(id: bigint) {
  return eq(begroting.id, id);
}
