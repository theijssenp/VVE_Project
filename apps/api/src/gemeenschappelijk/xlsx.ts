/**
 * Minimale XLSX-schrijver — dependency-vrij (blok B08, spec §8.2).
 *
 * Waarom zelfgebouwd en niet `exceljs` of `xlsx`: §8.2 en de dreigingenlijst
 * (§8.1, punt 5) noemen een gekaapte npm-afhankelijkheid met zoveel woorden als
 * reëel risico. G07 heeft om dezelfde reden zijn eigen PDF-schrijver. Wat hier
 * nodig is, is een tabel met tekst en getallen — geen formules, geen
 * draaitabellen, geen opmaakmotor. Dat weegt niet op tegen een boom van
 * afhankelijkheden in de productie-image.
 *
 * **Wat een xlsx is.** Een ZIP met een handvol XML-bestanden. Deze schrijver
 * zet ze ongecomprimeerd (`stored`) in het archief: een geldige ZIP-variant die
 * geen deflate-implementatie vereist. Bestanden van deze omvang — een balans en
 * een staat van baten en lasten — halen daarmee hooguit enkele tientallen kB.
 *
 * **Inline strings, geen `sharedStrings.xml`.** De gedeelde-stringtabel bestaat
 * om herhaalde tekst één keer op te slaan; bij een jaarrekening met een paar
 * honderd cellen is de winst nihil en de kans op een verkeerde index reëel.
 *
 * Getallen gaan als getal het blad in (`t="n"`), niet als tekst: anders kan de
 * ontvanger er niet mee rekenen, en dat is precies waarvoor hij om XLSX vroeg.
 * Bedragen worden hier in **euro's als decimaal getal** aangeleverd, niet in
 * centen — de ontvanger opent een spreadsheet, geen boekhoudsysteem. De
 * omrekening gebeurt bij de aanroeper, die weet wat een kolom betekent.
 */

/** Eén cel: tekst of getal. `null` levert een lege cel op. */
export type Cel = string | number | null;

export interface Blad {
  /** Tabnaam; Excel staat hier geen `\ / ? * [ ] :` en maximaal 31 tekens toe. */
  readonly naam: string;
  readonly rijen: readonly (readonly Cel[])[];
}

// --- ZIP-bouwstenen ---------------------------------------------------------

/** CRC-32 (IEEE 802.3), de variant die ZIP voorschrijft. */
function crc32(data: Buffer): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) {
      // 0xEDB88320 is het omgekeerde polynoom; de tak-vrije vorm houdt dit kort.
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

interface ZipInvoer {
  readonly pad: string;
  readonly inhoud: Buffer;
}

/**
 * Bouwt een ZIP met uitsluitend `stored`-entries.
 *
 * Opbouw: per bestand een local file header met de data, daarna de central
 * directory met dezelfde gegevens plus de offset, en tot slot het
 * end-of-central-directory-record. Datum en tijd staan vast op 1980-01-01: een
 * archief dat bij gelijke inhoud gelijke bytes oplevert is te vergelijken en te
 * testen, en de tijd van genereren staat toch al in het document zelf.
 */
function maakZip(invoeren: readonly ZipInvoer[]): Buffer {
  const lokaal: Buffer[] = [];
  const centraal: Buffer[] = [];
  let offset = 0;

  for (const { pad, inhoud } of invoeren) {
    const naam = Buffer.from(pad, 'utf8');
    const som = crc32(inhoud);

    const kop = Buffer.alloc(30);
    kop.writeUInt32LE(0x04034b50, 0); // signature
    kop.writeUInt16LE(20, 4); // versie nodig
    kop.writeUInt16LE(0, 6); // vlaggen
    kop.writeUInt16LE(0, 8); // methode: stored
    kop.writeUInt16LE(0, 10); // tijd
    kop.writeUInt16LE(33, 12); // datum: 1980-01-01
    kop.writeUInt32LE(som, 14);
    kop.writeUInt32LE(inhoud.length, 18);
    kop.writeUInt32LE(inhoud.length, 22);
    kop.writeUInt16LE(naam.length, 26);
    kop.writeUInt16LE(0, 28); // extra
    lokaal.push(kop, naam, inhoud);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // gemaakt door
    cd.writeUInt16LE(20, 6); // versie nodig
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(33, 14);
    cd.writeUInt32LE(som, 16);
    cd.writeUInt32LE(inhoud.length, 20);
    cd.writeUInt32LE(inhoud.length, 24);
    cd.writeUInt16LE(naam.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // commentaar
    cd.writeUInt16LE(0, 34); // schijf
    cd.writeUInt16LE(0, 36); // interne attributen
    cd.writeUInt32LE(0, 38); // externe attributen
    cd.writeUInt32LE(offset, 42);
    centraal.push(cd, naam);

    offset += kop.length + naam.length + inhoud.length;
  }

  const cdBuffer = Buffer.concat(centraal);
  const eind = Buffer.alloc(22);
  eind.writeUInt32LE(0x06054b50, 0);
  eind.writeUInt16LE(0, 4); // schijfnummer
  eind.writeUInt16LE(0, 6);
  eind.writeUInt16LE(invoeren.length, 8);
  eind.writeUInt16LE(invoeren.length, 10);
  eind.writeUInt32LE(cdBuffer.length, 12);
  eind.writeUInt32LE(offset, 16);
  eind.writeUInt16LE(0, 20); // commentaar

  return Buffer.concat([...lokaal, cdBuffer, eind]);
}

// --- SpreadsheetML ----------------------------------------------------------

function xmlTekst(waarde: string): string {
  return (
    waarde
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Excel weigert het bestand bij stuurtekens in de XML; die horen hier ook
      // niet te staan, dus weg ermee in plaats van een onleesbaar bestand.
      // eslint-disable-next-line no-control-regex -- stuurtekens weghalen ís hier het doel
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

/** Kolomnaam volgens Excel: 1 → A, 26 → Z, 27 → AA. */
export function kolomNaam(index: number): string {
  let n = index;
  let naam = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    naam = String.fromCharCode(65 + rest) + naam;
    n = Math.floor((n - 1) / 26);
  }
  return naam;
}

function cel(waarde: Cel, kolom: number, rij: number): string {
  if (waarde === null || waarde === '') return '';
  const ref = `${kolomNaam(kolom)}${String(rij)}`;
  if (typeof waarde === 'number') {
    // Niet-eindige getallen hebben geen representatie in een blad; die worden
    // een lege cel in plaats van een bestand dat Excel weigert te openen.
    if (!Number.isFinite(waarde)) return '';
    return `<c r="${ref}"><v>${String(waarde)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlTekst(waarde)}</t></is></c>`;
}

function bladXml(blad: Blad): string {
  const rijen = blad.rijen
    .map((rij, i) => {
      const nummer = i + 1;
      const cellen = rij.map((w, k) => cel(w, k + 1, nummer)).join('');
      return `<row r="${String(nummer)}">${cellen}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rijen}</sheetData></worksheet>`
  );
}

/** Excel weigert een tabnaam met deze tekens, of langer dan 31 tekens. */
function veiligeBladnaam(naam: string): string {
  const schoon = naam.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  return schoon === '' ? 'Blad1' : schoon;
}

/**
 * Bouwt een xlsx-bestand met één blad per {@link Blad}.
 *
 * De bytes zijn deterministisch: dezelfde invoer levert hetzelfde bestand, wat
 * het testbaar maakt zonder een xlsx-parser in de testafhankelijkheden te halen.
 */
export function bouwXlsx(bladen: readonly Blad[]): Buffer {
  if (bladen.length === 0) throw new Error('Een werkmap heeft ten minste één blad.');

  const bladRefs = bladen
    .map(
      (b, i) =>
        `<sheet name="${xmlTekst(veiligeBladnaam(b.naam))}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`,
    )
    .join('');

  const werkmapRels = bladen
    .map(
      (_, i) =>
        `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`,
    )
    .join('');

  const overrides = bladen
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  const bestanden: ZipInvoer[] = [
    {
      pad: '[Content_Types].xml',
      inhoud: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          overrides +
          '</Types>',
        'utf8',
      ),
    },
    {
      pad: '_rels/.rels',
      inhoud: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      pad: 'xl/workbook.xml',
      inhoud: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets>${bladRefs}</sheets></workbook>`,
        'utf8',
      ),
    },
    {
      pad: 'xl/_rels/workbook.xml.rels',
      inhoud: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          werkmapRels +
          '</Relationships>',
        'utf8',
      ),
    },
    ...bladen.map((b, i) => ({
      pad: `xl/worksheets/sheet${String(i + 1)}.xml`,
      inhoud: Buffer.from(bladXml(b), 'utf8'),
    })),
  ];

  return maakZip(bestanden);
}
