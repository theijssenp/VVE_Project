/**
 * Integratietest — documenten (V05, spec M3 · AC3.1–3.7).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0025, dus
 * `document` bestaat met RLS) en een tijdelijke opslagmap op schijf
 * (os.tmpdir, buiten de "webroot" — daar is er hier geen; AC3.7).
 * Controleert:
 *   - test #31: een uitvoerbaar bestand onder een `.pdf`-naam wordt
 *     geweigerd op het gedetecteerde MIME-type (server-side, AC3.1);
 *   - upload met UUID-schijfnaam, originele naam in de db, checksum;
 *   - AC3.2: zichtbaarheid — een gewone leden-rol ziet `alle_leden`, een
 *     bewoner ziet uitsluitend `bewoners`, bestuur ziet alles;
 *   - AC3.3: nieuwe versie — versie+1, oude op vervallen, keten via
 *     eerdere_versie_id;
 *   - AC3.5: zoeken op titel, categorie, jaar en tag;
 *   - AC3.7: de schijfnaam is een UUID, de originele naam staat in de db;
 *     download levert exact de geüploade bytes terug.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  document,
  persoon,
  rolToewijzing,
  vve,
  wooneenheid,
} from '../src/database/schema/index.js';
import { eigenaarschap } from '../src/database/schema/eigenaarschap.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import {
  maakDocumentenService,
  type DocumentenService,
  type ZichtBepaler,
} from '../src/financieel/documenten-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

// De magic bytes van de vijf toegestane typen + een uitvoerbaar bestand.
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('0'.repeat(2048))]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), // IHDR-lengte
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1]), // breedte 1
  Buffer.from([0, 0, 0, 1]), // hoogte 1
  Buffer.from([8, 6, 0, 0, 0]), // bitdiepte, kleurtype RGBA
  Buffer.alloc(4), // CRC
]);
const EXE_BYTES = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  Buffer.from('0'.repeat(2048)),
]);

/** ZichtBepaler-hulpen voor de test — zelfde regels als de service (AC3.2). */
function bepaler(rollen: readonly string[]): ZichtBepaler {
  const bestuur = ['beheerder', 'voorzitter', 'penningmeester', 'secretaris', 'bestuurslid'];
  return {
    ziet: (z) => {
      if (rollen.some((r) => bestuur.includes(r))) return true;
      // Een huurder/bewoner (zonder eigenaarsrol) ziet uitsluitend 'bewoners'.
      if (rollen.includes('bewoner') && !rollen.includes('eigenaar')) {
        return z === 'bewoners';
      }
      if (z === 'alle_leden') return true;
      if (z === 'bewoners') return rollen.includes('bewoner');
      return false;
    },
  };
}

describe('Documenten (V05, AC3.1–3.7)', () => {
  let db: TestPgDb | undefined;
  let service: DocumentenService | undefined;
  let opslagMap: string | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    opslagMap = await mkdtemp(join(tmpdir(), 'vve-doc-'));
    service = maakDocumentenService({
      db: db.db,
      klok: new SystemKlok(),
      opslagRoot: opslagMap,
    });
  });

  afterAll(async () => {
    if (opslagMap !== undefined) {
      await rm(opslagMap, { recursive: true, force: true });
    }
    await db?.stop();
  });

  interface Seed {
    readonly vveId: bigint;
    readonly beheerderId: bigint;
    readonly ledenId: bigint;
    readonly bewonerId: bigint;
  }

  /** Seedt een VvE + drie personen: beheerder, gewoon lid, bewoner. */
  async function seed(): Promise<Seed> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const uniek = `${n}-${String(Date.now())}-${randomUUID().slice(0, 8)}`;
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `V05-VvE-${n}` })
      .returning({ id: vve.id });
    const [beheerder] = await db.db
      .insert(persoon)
      .values({ email: `v05-${uniek}-b@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    const [lid] = await db.db
      .insert(persoon)
      .values({ email: `v05-${uniek}-l@test.vve`, achternaam: 'Lid' })
      .returning({ id: persoon.id });
    const [bewoner] = await db.db
      .insert(persoon)
      .values({ email: `v05-${uniek}-w@test.vve`, achternaam: 'Bewoner' })
      .returning({ id: persoon.id });
    if (v === undefined || beheerder === undefined || lid === undefined || bewoner === undefined) {
      throw new Error('seed faalde');
    }
    await db.db.insert(rolToewijzing).values([
      { vveId: v.id, persoonId: beheerder.id, rol: 'beheerder', startDatum: '2026-01-01' },
      { vveId: v.id, persoonId: lid.id, rol: 'eigenaar', startDatum: '2026-01-01' },
      { vveId: v.id, persoonId: bewoner.id, rol: 'bewoner', startDatum: '2026-01-01' },
    ]);
    // Een eenheid met de seed-eigenaar (de 'bewoner'-rol is los van eigendom).
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: 'A-01' })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('eenheid-seed faalde');
    await db.db.insert(eigenaarschap).values({
      vveId: v.id,
      wooneenheidId: e.id,
      persoonId: lid.id,
      aandeelPromille: 1000,
      isPrimairContact: true,
      periode: '[2026-01-01,)',
    });
    return { vveId: v.id, beheerderId: beheerder.id, ledenId: lid.id, bewonerId: bewoner.id };
  }

  it('test #31 — uitvoerbare inhoud onder .pdf-naam wordt op MIME geweigerd', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    await expect(
      service.upload(
        s.vveId,
        {
          bytes: EXE_BYTES,
          origineleNaam: 'fijn-stukje.pdf',
          categorie: 'overig',
          titel: 'Uitvoerbaar als pdf',
          zichtbaarheid: 'bestuur',
        },
        s.beheerderId,
      ),
    ).rejects.toThrow(/niet toegestaan/);
  });

  it('AC3.1/AC3.7 — upload: UUID-schijfnaam, originele naam in de db, checksum, bytes terug', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    const { id, versie } = await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'Splitsingsakte 2026.pdf',
        categorie: 'splitsingsakte',
        titel: 'Splitsingsakte',
        zichtbaarheid: 'alle_leden',
      },
      s.beheerderId,
    );
    expect(versie).toBe(1);
    expect(id).toBeGreaterThan(0n);

    const [rij] = await db.db
      .select({
        opslagPad: document.opslagPad,
        origineleNaam: document.origineleNaam,
        mimeType: document.mimeType,
        checksum: document.checksumSha256,
      })
      .from(document)
      .where(and(eq(document.vveId, s.vveId), eq(document.id, id)))
      .limit(1);
    if (rij === undefined) throw new Error('document-rij ontbreekt');
    // De schijfnaam is een UUID met .pdf; de originele naam staat in de db.
    expect(rij.opslagPad).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(rij.origineleNaam).toBe('Splitsingsakte 2026.pdf');
    expect(rij.mimeType).toBe('application/pdf');
    expect(rij.checksum).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));

    // Het bestand staat écht op schijf, onder de UUID-naam.
    const opSchijf = await readFile(join(opslagMap ?? '.', rij.opslagPad));
    expect(opSchijf.equals(PDF_BYTES)).toBe(true);

    // AC3.7: download levert exact dezelfde bytes (beheerder ziet alles).
    const geleverd = await service.leverBestand(s.vveId, id, bepaler(['beheerder']));
    expect(geleverd.bytes.equals(PDF_BYTES)).toBe(true);
    expect(geleverd.origineleNaam).toBe('Splitsingsakte 2026.pdf');
    expect(geleverd.mimeType).toBe('application/pdf');
  });

  it('AC3.2 — zichtbaarheid: bewoner ziet uitsluitend bewoners-markering', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'a.pdf',
        categorie: 'notulen',
        titel: 'Notulen',
        zichtbaarheid: 'alle_leden',
      },
      s.beheerderId,
    );
    await service.upload(
      s.vveId,
      {
        bytes: PNG_BYTES,
        origineleNaam: 'b.png',
        categorie: 'overig',
        titel: 'Huisregels',
        zichtbaarheid: 'bewoners',
      },
      s.beheerderId,
    );
    await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'c.pdf',
        categorie: 'jaarrekening',
        titel: 'Concept jaarrekening',
        zichtbaarheid: 'alleen_beheerder',
      },
      s.beheerderId,
    );

    const vanBeheerder = await service.lijst(s.vveId, bepaler(['beheerder']));
    expect(vanBeheerder).toHaveLength(3);

    const vanLid = await service.lijst(s.vveId, bepaler(['eigenaar']));
    expect(vanLid).toHaveLength(1);
    expect(vanLid[0]?.zichtbaarheid).toBe('alle_leden');

    const vanBewoner = await service.lijst(s.vveId, bepaler(['bewoner']));
    expect(vanBewoner).toHaveLength(1);
    expect(vanBewoner[0]?.zichtbaarheid).toBe('bewoners');
    expect(vanBewoner[0]?.titel).toBe('Huisregels');
  });

  it('AC3.3 — nieuwe versie: versie+1, oude vervallen, keten via eerdere_versie_id', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    const eerste = await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'begroting.pdf',
        categorie: 'begroting',
        titel: 'Begroting 2027',
        zichtbaarheid: 'alle_leden',
      },
      s.beheerderId,
    );
    const tweede = await service.nieuweVersie(
      s.vveId,
      eerste.id,
      { bytes: PNG_BYTES, origineleNaam: 'begroting-v2.png' },
      s.beheerderId,
    );
    expect(tweede.versie).toBe(2);

    const [oude] = await db.db
      .select({ vervallenOp: document.vervallenOp, versie: document.versie })
      .from(document)
      .where(and(eq(document.vveId, s.vveId), eq(document.id, eerste.id)))
      .limit(1);
    const [nieuwe] = await db.db
      .select({
        eerdere: document.eerdereVersieId,
        versie: document.versie,
        titel: document.titel,
        cat: document.categorie,
        zicht: document.zichtbaarheid,
      })
      .from(document)
      .where(and(eq(document.vveId, s.vveId), eq(document.id, tweede.id)))
      .limit(1);
    if (oude === undefined || nieuwe === undefined) throw new Error('versie-rijen ontbreken');
    expect(oude.vervallenOp).not.toBeNull();
    expect(oude.versie).toBe(1);
    expect(nieuwe.eerdere).toBe(eerste.id);
    // De metadata (titel, categorie, zichtbaarheid) is overgenomen van de oude.
    expect(nieuwe.titel).toBe('Begroting 2027');
    expect(nieuwe.cat).toBe('begroting');
    expect(nieuwe.zicht).toBe('alle_leden');

    // Een derde versie van de óóude (vervallen) versie wordt geweigerd.
    await expect(
      service.nieuweVersie(
        s.vveId,
        eerste.id,
        { bytes: PDF_BYTES, origineleNaam: 'x.pdf' },
        s.beheerderId,
      ),
    ).rejects.toThrow(/al vervangen/);
  });

  it('AC3.5 — zoeken op titel, categorie, jaar en tag', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();

    await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'n1.pdf',
        categorie: 'notulen',
        titel: 'Notulen ALV april',
        zichtbaarheid: 'alle_leden',
        jaar: 2026,
        tags: ['alv', '2026'],
      },
      s.beheerderId,
    );
    await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'p1.pdf',
        categorie: 'verzekeringspolis',
        titel: 'Opstalverzekering',
        zichtbaarheid: 'alle_leden',
        jaar: 2027,
        tags: ['polis'],
      },
      s.beheerderId,
    );

    const opTitel = await service.zoek(s.vveId, bepaler(['beheerder']), { tekst: 'alv april' });
    expect(opTitel).toHaveLength(1);
    expect(opTitel[0]?.categorie).toBe('notulen');

    const opCategorie = await service.zoek(s.vveId, bepaler(['beheerder']), {
      categorie: 'verzekeringspolis',
    });
    expect(opTitel).toHaveLength(1);
    expect(opCategorie).toHaveLength(1);

    const opJaar = await service.zoek(s.vveId, bepaler(['beheerder']), { jaar: 2027 });
    expect(opJaar).toHaveLength(1);
    expect(opJaar[0]?.titel).toBe('Opstalverzekering');

    const opTag = await service.zoek(s.vveId, bepaler(['beheerder']), { tag: 'polis' });
    expect(opTag).toHaveLength(1);
    expect(opTag[0]?.titel).toBe('Opstalverzekering');

    const zonder = await service.zoek(s.vveId, bepaler(['beheerder']), { tekst: 'bestaat-niet' });
    expect(zonder).toHaveLength(0);
  });

  it('AC3.2+download — een bewoner kan een bestuur-document niet downloaden (404-klasse)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const s = await seed();
    const { id } = await service.upload(
      s.vveId,
      {
        bytes: PDF_BYTES,
        origineleNaam: 'geheim.pdf',
        categorie: 'overig',
        titel: 'Geheim',
        zichtbaarheid: 'bestuur',
      },
      s.beheerderId,
    );
    await expect(service.leverBestand(s.vveId, id, bepaler(['bewoner']))).rejects.toThrow(
      /niet gevonden/,
    );
    // Bestuur wél.
    const bestand = await service.leverBestand(s.vveId, id, bepaler(['secretaris']));
    expect(bestand.bytes.equals(PDF_BYTES)).toBe(true);
  });
});
