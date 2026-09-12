/**
 * CSV/XLSX-tabel-lezer — blok V06 (spec M2 · AC2.7).
 *
 * Een dependency-vrije tabellezer: parseert CSV (RFC 4180: komma of
 * puntkomma, dubbele aanhalingstekens met verdubbeling, CRLF) en XLSX
 * (een ZIP-archief met XML-werkbladen, gedecomprimeerd met Node-zlib). Het
 * resultaat is voor beide formaten dezelfde rij-vorm: een kopregel-velden-
 * map per datarij, zodat de import-service één pad kent.
 *
 * **Waarom dependency-vrij:** het G07-PDF-besluit (nota-pdf.ts) koos bewust
 * voor een minimale, te-begrijpen-schrijver boven een grote bibliotheek voor
 * één formaat. Dezelfde filosofie hier: de XLSX-lezer leest precies wat een
 * import-werkblad nodig heeft — celwaarden uit één sheet, gedeelde strings,
 * getallen — en weigert wat hij niet begrijpt, in plaats van 1,5 MB parser
 * met twintig formaten binnen te halen. `zlib.inflateRawSync` doet het
 * decompressiewerk (Node-kern, geen dependency).
 *
 * **XLSX-begrenzing:** de ZIP-les leest uitsluitend stored- en deflate-
 * entries, met handmatige lokale-header-walk en centrale-directory-afslag;
 * gecodeerde/archief-varianten worden geweigerd. De XML-lezer is een
 * beperkte walker (`<c r="A1" t="s"><v>12</v></c>`) — geen volledige
 * XML-parse, alleen het cel-gerichte pad dat XLSX schrijft.
 */

import { inflateRawSync } from 'node:zlib';

/** Een tabel als rijen van kolomnaam → celwaarde (headerregel = kolomnamen). */
export type CelRij = readonly (readonly [kolom: string, waarde: string])[];

export interface GeparseerdeTabel {
  readonly koppen: readonly string[];
  readonly rijen: readonly CelRij[];
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

/** Parseert CSV-tekst. De scheidingsteken wordt per bestand bepaald: de
 * kopregel bepaalt of `,` of `;` meer kolommen oplevert (Nederlandse
 * spreadsheet-exporten sturen puntkomma; internationale komma).
 */
export function parseCsv(tekst: string): GeparseerdeTabel {
  const scheiding = kiesScheiding(tekst);
  const rijen = leesCsvRijen(tekst, scheiding);
  if (rijen.length === 0) {
    throw new Error('Het CSV-bestand bevat geen kopregel.');
  }
  const koppen = rijen[0] ?? [];
  return {
    koppen,
    rijen: rijen
      .slice(1)
      .map((rij) => koppen.map((kop, i) => [kop, rij[i] ?? ''] as readonly [string, string])),
  };
}

/** Kiest `,` of `;` op de kopregel: het teken dat buiten quotes het meeste voorkomt. */
function kiesScheiding(tekst: string): string {
  const kop = tekst.split(/\r?\n/, 1)[0] ?? '';
  let buitenQuote = true;
  let komma = 0;
  let puntkomma = 0;
  for (const teken of kop) {
    if (teken === '"') buitenQuote = !buitenQuote;
    else if (buitenQuote && teken === ',') komma += 1;
    else if (buitenQuote && teken === ';') puntkomma += 1;
  }
  return puntkomma > komma ? ';' : ',';
}

/** Een statemachine-parser: quote-aware, met verdubbelde quotes en CRLF. */
function leesCsvRijen(tekst: string, scheiding: string): string[][] {
  const rijen: string[][] = [];
  let cel = '';
  let rij: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < tekst.length; i += 1) {
    const teken = tekst[i] ?? '';
    if (inQuotes) {
      if (teken === '"') {
        const volgende = tekst[i + 1];
        if (volgende === '"') {
          cel += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cel += teken;
      }
      continue;
    }
    if (teken === '"') {
      inQuotes = true;
    } else if (teken === scheiding) {
      rij.push(cel);
      cel = '';
    } else if (teken === '\n') {
      rij.push(cel);
      cel = '';
      if (rij.some((c) => c !== '')) rijen.push(rij);
      rij = [];
    } else if (teken === '\r') {
      // CR voor LF of alleen-staand CR: als scheiding van rij afhandelen;
      // de \n die volgt wordt hier niet gedubbeld geteld.
      rij.push(cel);
      cel = '';
      if (rij.some((c) => c !== '')) rijen.push(rij);
      rij = [];
      if (tekst[i + 1] === '\n') i += 1;
    } else {
      cel += teken;
    }
  }
  // Laatste rij zonder afsluitende newline.
  if (cel !== '' || rij.length > 0) {
    rij.push(cel);
    if (rij.some((c) => c !== '')) rijen.push(rij);
  }
  return rijen;
}

// ---------------------------------------------------------------------------
// XLSX (ZIP-van-XML, gelezen met node:zlib)
// ---------------------------------------------------------------------------

/** Parseert een XLSX-blob en leest het EERSTE werkblad als tabel. */
export function parseXlsx(bytes: Buffer): GeparseerdeTabel {
  const leden = leesZipLeden(bytes);
  const gedeeld = leesGedeeldeStrings(leden);
  const blad =
    leden.find((l) => l.pad === 'xl/worksheets/sheet1.xml') ??
    leden.find((l) => l.pad.startsWith('xl/worksheets/'));
  if (blad === undefined) {
    throw new Error('Het bestand bevat geen werkblad (geen xl/worksheets/*-entry).');
  }
  const xml = blad.inhoud.toString('utf8');
  return leesWerkblad(xml, gedeeld);
}

interface ZipLid {
  readonly pad: string;
  readonly inhoud: Buffer;
}

/**
 * Wandelt de lokale bestandsheaders van een ZIP-archief. Uitsluitend
 * store (0) en deflate (8) worden ondersteund; alles anders wordt
 * geweigerd (XLSX van Excel is altijd een van de twee).
 */
function leesZipLeden(bytes: Buffer): readonly ZipLid[] {
  const leden: ZipLid[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    // Lokale bestandsheader-signatuur: PK\x03\x04.
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const methode = bytes.readUInt16LE(offset + 8);
    if (methode !== 0 && methode !== 8) {
      throw new Error(`ZIP-compressiemethode ${String(methode)} wordt niet ondersteund.`);
    }
    const gecomprimeerdeLengte = bytes.readUInt32LE(offset + 18);
    const naamLengte = bytes.readUInt16LE(offset + 26);
    const extraLengte = bytes.readUInt16LE(offset + 28);
    const naamStart = offset + 30;
    const pad = bytes.subarray(naamStart, naamStart + naamLengte).toString('utf8');
    const dataStart = naamStart + naamLengte + extraLengte;
    const data = bytes.subarray(dataStart, dataStart + gecomprimeerdeLengte);
    if (methode === 0) {
      leden.push({ pad, inhoud: data });
    } else {
      leden.push({ pad, inhoud: inflateRawSync(data) });
    }
    offset = dataStart + gecomprimeerdeLengte;
    // Data-descriptor (methode 8, bit 3 in flags): XLSX schrijft die niet,
    // en zonder lengte in de lokale header kan de walk niet door. We stoppen
    // bij de centrale directory (PK\x01\x02) — die volgt op de lokale leden —
    // en vóór het einde van de buffer (kleine bestanden zonder directory).
    if (offset + 4 > bytes.length) break;
    const volgende = bytes.readUInt32LE(offset);
    if (volgende === 0x02014b50 || volgende !== 0x04034b50) break;
  }
  return leden;
}

/**
 * xl/sharedStrings.xml: `<si><t>tekst</t></si>` per index. Rich-text-si's met
 * meerdere `<t>`-delen worden samengevoegd (Excel schrijft ze zelden in
 * import-bestanden; samenvoegen is de veilige leesvorm).
 */
function leesGedeeldeStrings(leden: readonly ZipLid[]): readonly string[] {
  const lid = leden.find((l) => l.pad === 'xl/sharedStrings.xml');
  if (lid === undefined) return [];
  const xml = lid.inhoud.toString('utf8');
  const uitslag: string[] = [];
  const patroon = /<si>([\s\S]*?)<\/si>/g;
  let match = patroon.exec(xml);
  while (match !== null) {
    uitslag.push(tDelenSamen(match[1] ?? ''));
    match = patroon.exec(xml);
  }
  return uitslag;
}

/** Alle `<t>…</t>`-delen in een <si>-fragment, ontsnapt, samengevoegd. */
function tDelenSamen(siInhoud: string): string {
  const delen: string[] = [];
  const patroon = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match = patroon.exec(siInhoud);
  while (match !== null) {
    delen.push(ontsnapXml(match[1] ?? ''));
    match = patroon.exec(siInhoud);
  }
  return delen.join('');
}

/**
 * Leest het werkblad-XML: `<c r="A1" t="s|str|n|b"><v>…</v></c>`. Kolom-
 * letters worden via de Excel-basis-26-vorm naar een kolomindex gebracht
 * (A=0, Z=25, AA=26, …). Lege cellen ontbreken in de XML — de kopregel
 * bepaalt de kolomvolgorde, dus dat is genoeg.
 */
function leesWerkblad(xml: string, gedeeld: readonly string[]): GeparseerdeTabel {
  const rijRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const rijen: string[][] = [];
  let rijMatch: RegExpExecArray | null = rijRegex.exec(xml);
  while (rijMatch !== null) {
    rijen.push(leesCellen(rijMatch[0], gedeeld));
    rijMatch = rijRegex.exec(xml);
  }
  if (rijen.length === 0) {
    throw new Error('Het werkblad bevat geen rijen.');
  }
  const koppen = rijen[0] ?? [];
  return {
    koppen,
    rijen: rijen
      .slice(1)
      .map((rij) => koppen.map((kop, i) => [kop, rij[i] ?? ''] as readonly [string, string])),
  };
}

/**
 * De cellen van één `<row>`, in kolomvolgorde. De kolomletter in `r="C5"`
 * bepaalt de positie — ontbrekende cellen vullen de tussenliggende kolommen
 * met lege strings.
 */
function leesCellen(rijXml: string, gedeeld: readonly string[]): string[] {
  const celPatroon = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  const cellen: string[] = [];
  let celMatch: RegExpExecArray | null = celPatroon.exec(rijXml);
  while (celMatch !== null) {
    const attributen = celMatch[1] ?? '';
    const inhoud = celMatch[2] ?? '';
    const kolomVerwijzing = /r="([A-Z]+)\d+"/.exec(attributen)?.[1] ?? '';
    const index = kolomindex(kolomVerwijzing);
    const type = /t="(s|str|b|n|inlineStr)"/.exec(attributen)?.[1] ?? 'n';
    const vWaarde = /<v>([\s\S]*?)<\/v>/.exec(inhoud)?.[1] ?? '';
    let waarde: string;
    switch (type) {
      case 's': {
        const idx = Number(vWaarde);
        waarde = Number.isInteger(idx) ? (gedeeld[idx] ?? '') : '';
        break;
      }
      case 'inlineStr': {
        waarde = tDelenSamen(inhoud);
        break;
      }
      case 'b': {
        waarde = vWaarde === '1' ? 'waar' : 'onwaar';
        break;
      }
      case 'str':
      case 'n':
      default: {
        waarde = ontsnapXml(vWaarde);
        break;
      }
    }
    while (cellen.length < index) cellen.push('');
    cellen[index] = waarde;
    celMatch = celPatroon.exec(rijXml);
  }
  return cellen;
}

/** "A"→0, "B"→1, … "Z"→25, "AA"→26 (Excel-kolomletters). */
function kolomindex(letters: string): number {
  let index = 0;
  for (const teken of letters.toUpperCase()) {
    index = index * 26 + (teken.charCodeAt(0) - 64);
  }
  return index - 1;
}

function ontsnapXml(tekst: string): string {
  return tekst
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Één ingang voor de import-service
// ---------------------------------------------------------------------------

/** Detecteert CSV tegen XLSX op de magic bytes (PK\x03\x04 = ZIP = XLSX). */
export function parseTabel(bytes: Buffer): GeparseerdeTabel {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    return parseXlsx(bytes);
  }
  return parseCsv(bytes.toString('utf8'));
}
