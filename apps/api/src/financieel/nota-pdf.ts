/**
 * PDF-bouwsteen — blok G07 (spec §6.6 · AC13.5).
 *
 * Een minimale, dependency-vrije PDF-schrijver voor de nota's. De spec-eis
 * is een *leesbaar bewijsstuk* met het logo van de VvE, het nummer, het
 * betalingskenmerk, de specificatie exploitatie/reservefonds en de
 * vervaldatum — geen typografie-wedstrijd. PDF 1.4 met base-14-font Helvetica
 * en Helvetica-Bold; ASCII-only teksten (accentslagen ontbreken dan, bewust:
 * de inhoud is wél exact, en de teksten uit de db zijn Nederlands zonder
 * tekens buiten WinAnsi).
 *
 * Een PDF met n pagina's is een reeks objecten + een xref-tabel. Deze helper
 * bouwt precies één pagina met kopblok, adresserende regels, de regeltabel
 * en totalen — en levert de bytes.
 */

/** Regels op de nota; bedragen in centen (domein F05). */
export interface PdfRegel {
  readonly omschrijving: string;
  readonly bedragCent: number;
  readonly isReservefonds: boolean;
}

export interface NotaPdfInvoer {
  readonly vveNaam: string;
  readonly nummer: string;
  readonly betalingskenmerk: string;
  readonly eenheidCode: string;
  readonly periodeLabel: string;
  readonly factuurdatum: string;
  readonly vervaldatum: string;
  readonly betaalwijze: string;
  readonly regels: readonly PdfRegel[];
}

/** De basis-14 fonts; de PDF leest ze zonder ingesloten bestand. */
function escape(tekst: string): string {
  return tekst.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** PDF-string in WinAnsi; tekens buiten 0–255 vallen weg (bewust). */
function pdfTekst(tekst: string): string {
  return tekst
    .split('')
    .map((c) => (c.charCodeAt(0) > 255 ? '?' : c))
    .join('');
}

function euromerkBedrag(centen: number): string {
  const negatief = centen < 0;
  const abs = Math.abs(centen);
  const euro = Math.floor(abs / 100);
  const cent = String(abs % 100).padStart(2, '0');
  return `${negatief ? '-' : ''}${String(euro).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cent}`;
}

/** Eén pagina: kop, debiteur, tabel, totalen, kenmerkregel. */
export function bouwNotaPdf(invoer: NotaPdfInvoer): Buffer {
  const totaalExploitatie = invoer.regels
    .filter((r) => !r.isReservefonds)
    .reduce((t, r) => t + r.bedragCent, 0);
  const totaalReserve = invoer.regels
    .filter((r) => r.isReservefonds)
    .reduce((t, r) => t + r.bedragCent, 0);
  const totaal = totaalExploitatie + totaalReserve;

  // Tekstregels in twee groottes; y loopt vanaf de onderkant (PDF-coördinaten).
  const regels: string[] = [];
  const tekst = (x: number, y: number, font: string, grootte: number, inhoud: string) => {
    regels.push(
      `BT /${font} ${String(grootte)} Tf ${String(x)} ${String(y)} Td (${pdfTekst(escape(inhoud))}) Tj ET`,
    );
  };

  // Kopblok (y=800-760).
  tekst(56, 800, 'Helvetica-Bold', 16, invoer.vveNaam);
  tekst(56, 780, 'Helvetica', 10, 'Vereniging van Eigenaren');
  tekst(420, 800, 'Helvetica', 10, `Nota ${invoer.nummer}`);
  tekst(420, 786, 'Helvetica', 10, `Factuurdatum ${invoer.factuurdatum}`);
  tekst(420, 772, 'Helvetica', 10, `Vervaldatum ${invoer.vervaldatum}`);

  // Debiteur / periode.
  tekst(56, 730, 'Helvetica-Bold', 11, `Eenheid ${invoer.eenheidCode}`);
  tekst(56, 716, 'Helvetica', 10, invoer.periodeLabel);
  tekst(56, 700, 'Helvetica', 10, `Betaalwijze: ${invoer.betaalwijze}`);

  // Tabelkop.
  const tabelY = 660;
  tekst(56, tabelY, 'Helvetica-Bold', 10, 'Specificatie');
  tekst(420, tabelY, 'Helvetica-Bold', 10, 'Bedrag');

  let y = tabelY - 16;
  for (const r of invoer.regels) {
    const soort = r.isReservefonds ? ' (reservefonds)' : '';
    tekst(56, y, 'Helvetica', 10, `${r.omschrijving}${soort}`);
    tekst(460, y, 'Helvetica', 10, euromerkBedrag(r.bedragCent));
    y -= 14;
  }

  // Totalen.
  y -= 6;
  tekst(380, y, 'Helvetica', 10, 'Totaal exploitatie');
  tekst(490, y, 'Helvetica', 10, euromerkBedrag(totaalExploitatie));
  y -= 14;
  tekst(380, y, 'Helvetica', 10, 'Totaal reservefonds');
  tekst(490, y, 'Helvetica', 10, euromerkBedrag(totaalReserve));
  y -= 16;
  tekst(380, y, 'Helvetica-Bold', 12, 'Totaal te betalen');
  tekst(490, y, 'Helvetica-Bold', 12, euromerkBedrag(totaal));

  // Kenmerkregel — de spil van het afletteren (AC7.4-stap 1).
  y -= 40;
  tekst(56, y, 'Helvetica-Bold', 11, `Betalingskenmerk: ${invoer.betalingskenmerk}`);
  y -= 14;
  tekst(56, y, 'Helvetica', 9, `Gelieve dit kenmerk bij uw overboeking te vermelden.`);

  const inhoud = regels.join('\n');
  const objecten: string[] = [
    // 1: catalogus
    '<< /Type /Catalog /Pages 2 0 R >>',
    // 2: pagina's
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    // 3: pagina (A4: 595 x 842 pt)
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    // 4: inhoudsstroom
    `<< /Length ${String(inhoud.length)} >>\nstream\n${inhoud}\nendstream`,
    // 5/6: de twee fonts
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

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
