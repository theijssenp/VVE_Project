/**
 * Minimale, dependency-vrije PDF-schrijver — gedeeld (blok B08, spec §8.2).
 *
 * G07 schreef zijn eigen PDF-bouwer voor de nota's, om de reden die §8.1 punt 5
 * noemt: een gekaapte npm-afhankelijkheid is een reëel risico, en een
 * bewijsstuk van een halve pagina rechtvaardigt geen opmaakmotor. Bij de
 * jaarrekening kwam dezelfde behoefte terug, nu met **meer regels dan op één
 * pagina passen**. Vandaar deze gedeelde laag: hij kent geen nota's en geen
 * jaarrekeningen, alleen pagina's met tekstregels.
 *
 * PDF 1.4 met de base-14-fonts Helvetica en Helvetica-Bold, die elke lezer
 * zonder ingesloten bestand kent. Teksten gaan als WinAnsi het bestand in;
 * tekens daarbuiten worden `?`. Dat is bewust: de inhoud (bedragen, nummers,
 * data) is exact, en de Nederlandse teksten uit de database vallen binnen
 * WinAnsi.
 */

/** Haakjes en backslashes zijn in een PDF-string stuurtekens. */
function escape(tekst: string): string {
  return tekst.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Tekens buiten WinAnsi hebben geen glyph in een base-14-font. */
function winAnsi(tekst: string): string {
  return tekst
    .split('')
    .map((c) => (c.charCodeAt(0) > 255 ? '?' : c))
    .join('');
}

export type Font = 'Helvetica' | 'Helvetica-Bold';

/** Eén tekstregel op een pagina, in punten vanaf linksonder. */
export interface PdfRegel {
  readonly x: number;
  readonly y: number;
  readonly font: Font;
  readonly grootte: number;
  readonly tekst: string;
}

/** A4 in punten; de enige maat die deze applicatie gebruikt. */
export const A4_BREEDTE = 595;
export const A4_HOOGTE = 842;

function stroomVan(regels: readonly PdfRegel[]): string {
  return regels
    .map(
      (r) =>
        `BT /${r.font === 'Helvetica-Bold' ? 'F2' : 'F1'} ${String(r.grootte)} Tf ` +
        `${String(r.x)} ${String(r.y)} Td (${escape(winAnsi(r.tekst))}) Tj ET`,
    )
    .join('\n');
}

/**
 * Zet pagina's met tekstregels om in PDF-bytes.
 *
 * Elke pagina wordt een eigen inhoudsstroom. De objectnummering is: 1 catalogus,
 * 2 pagina-boom, dan per pagina een pagina-object en een stroom, en tot slot de
 * twee fonts. De xref-tabel verwijst naar de byte-offsets; die worden tijdens
 * het schrijven bijgehouden, want achteraf terugrekenen is precies waar dit
 * formaat mensen laat struikelen.
 */
export function bouwPdf(paginas: readonly (readonly PdfRegel[])[]): Buffer {
  if (paginas.length === 0) throw new Error('Een PDF heeft ten minste één pagina.');

  const aantal = paginas.length;
  // 1 = catalogus, 2 = pagina-boom, 3..(2+n) = pagina's, dan de stromen, dan fonts.
  const eerstePagina = 3;
  const eersteStroom = eerstePagina + aantal;
  const fontGewoon = eersteStroom + aantal;
  const fontVet = fontGewoon + 1;

  const kinderen = paginas.map((_, i) => `${String(eerstePagina + i)} 0 R`).join(' ');

  const objecten: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kinderen}] /Count ${String(aantal)} >>`,
  ];

  for (let i = 0; i < aantal; i += 1) {
    objecten.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(A4_BREEDTE)} ${String(A4_HOOGTE)}] ` +
        `/Contents ${String(eersteStroom + i)} 0 R ` +
        `/Resources << /Font << /F1 ${String(fontGewoon)} 0 R /F2 ${String(fontVet)} 0 R >> >> >>`,
    );
  }

  for (const pagina of paginas) {
    const inhoud = stroomVan(pagina);
    objecten.push(`<< /Length ${String(inhoud.length)} >>\nstream\n${inhoud}\nendstream`);
  }

  objecten.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  let pdf = '%PDF-1.4\n';
  const posities: number[] = [];
  for (let i = 0; i < objecten.length; i += 1) {
    posities.push(pdf.length);
    pdf += `${String(i + 1)} 0 obj\n${objecten[i] ?? ''}\nendobj\n`;
  }
  const xrefPositie = pdf.length;
  pdf += `xref\n0 ${String(objecten.length + 1)}\n0000000000 65535 f \n`;
  for (const p of posities) {
    pdf += `${String(p).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objecten.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefPositie)}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Hulp voor tabelachtige documenten: breekt een stroom regels af op paginahoogte.
 *
 * `schrijf` krijgt een functie waarmee hij een regel wegzet; die bepaalt zelf
 * wanneer er een nieuwe pagina begint. Zo hoeft de aanroeper niet zelf de
 * y-coördinaat en de paginagrens bij te houden — de plek waar dit soort code
 * normaal gesproken misgaat.
 */
export class PaginaOpbouw {
  readonly #paginas: PdfRegel[][] = [[]];
  #y: number;

  constructor(
    private readonly marge = 56,
    private readonly boven = A4_HOOGTE - 56,
    private readonly onder = 56,
  ) {
    this.#y = boven;
  }

  /** Zet een regel neer en begint een nieuwe pagina als de ruimte op is. */
  regel(
    tekst: string,
    opties?: { font?: Font; grootte?: number; x?: number; hoogte?: number },
  ): void {
    const grootte = opties?.grootte ?? 10;
    if (this.#y - grootte < this.onder) {
      this.#paginas.push([]);
      this.#y = this.boven;
    }
    const huidige = this.#paginas[this.#paginas.length - 1];
    huidige?.push({
      x: opties?.x ?? this.marge,
      y: this.#y,
      font: opties?.font ?? 'Helvetica',
      grootte,
      tekst,
    });
    // De regelafstand schuift mee met de tekengrootte; zonder deze stap zou
    // alles op dezelfde regel belanden.
    this.#y -= opties?.hoogte ?? grootte + 4;
  }

  /** Schrijft meerdere stukken op dezelfde regel (kolommen). */
  kolommen(
    stukken: readonly { tekst: string; x: number; font?: Font; grootte?: number }[],
    hoogte = 14,
  ): void {
    const grootte = stukken[0]?.grootte ?? 10;
    if (this.#y - grootte < this.onder) {
      this.#paginas.push([]);
      this.#y = this.boven;
    }
    const huidige = this.#paginas[this.#paginas.length - 1];
    for (const s of stukken) {
      huidige?.push({
        x: s.x,
        y: this.#y,
        font: s.font ?? 'Helvetica',
        grootte: s.grootte ?? 10,
        tekst: s.tekst,
      });
    }
    this.#y -= hoogte;
  }

  /** Witruimte zonder tekst. */
  ruimte(punten = 10): void {
    this.#y -= punten;
  }

  bytes(): Buffer {
    return bouwPdf(this.#paginas);
  }
}
