/**
 * Jaarrekening naar XLSX en platte tekst — blok B08 (AC9.4).
 *
 * De XLSX-kant gebruikt de dependency-vrije schrijver uit
 * `gemeenschappelijk/xlsx.ts`. Twee bladen: **Balans** en
 * **Baten en lasten** — dat is hoe een jaarrekening gelezen wordt, en het
 * scheelt de ontvanger het uitsplitsen van één lange lijst.
 *
 * **Bedragen gaan als euro's het blad in, niet als centen.** Binnen de
 * applicatie is de cent de eenheid (§5.1), maar wie een spreadsheet opent
 * verwacht `1234,56` en wil er direct mee kunnen rekenen en optellen. De
 * omrekening gebeurt hier, op de rand, en nergens anders — en met een deling
 * door 100 op een geheel getal, dus zonder afrondrisico.
 */

import { bouwXlsx, type Blad, type Cel } from '../gemeenschappelijk/xlsx.js';
import { PaginaOpbouw } from '../gemeenschappelijk/pdf.js';
import type { Jaarrekening, JaarrekeningGroep } from './jaarrekening-service.js';

/** Centen naar euro's als decimaal getal; deling van een geheel getal. */
export function euro(centen: number): number {
  return centen / 100;
}

/** Kopregel van een blad: de vergelijkende kolommen alleen als ze er zijn. */
function kop(jr: Jaarrekening): Cel[] {
  const rij: Cel[] = ['Rekening', 'Omschrijving', String(jr.jaar)];
  if (jr.vorigJaar !== null) rij.push(String(jr.vorigJaar));
  if (jr.heeftBegroting) rij.push('Begroot');
  return rij;
}

function groepRijen(groep: JaarrekeningGroep, jr: Jaarrekening): Cel[][] {
  const rijen: Cel[][] = [[groep.titel]];
  for (const r of groep.regels) {
    const rij: Cel[] = [r.nummer, r.naam, euro(r.bedragCent)];
    if (jr.vorigJaar !== null) rij.push(r.vorigJaarCent === null ? null : euro(r.vorigJaarCent));
    if (jr.heeftBegroting) rij.push(r.begrootCent === null ? null : euro(r.begrootCent));
    rijen.push(rij);
  }
  const totaal: Cel[] = ['', `Totaal ${groep.titel.toLowerCase()}`, euro(groep.totaalCent)];
  if (jr.vorigJaar !== null) {
    totaal.push(groep.totaalVorigJaarCent === null ? null : euro(groep.totaalVorigJaarCent));
  }
  if (jr.heeftBegroting) {
    totaal.push(groep.totaalBegrootCent === null ? null : euro(groep.totaalBegrootCent));
  }
  rijen.push(totaal, []);
  return rijen;
}

/** De twee bladen van de jaarrekening als werkmap. */
export function bouwJaarrekeningXlsx(jr: Jaarrekening): Buffer {
  const balans: Blad = {
    naam: 'Balans',
    rijen: [
      [`Jaarrekening ${jr.vveNaam} — ${String(jr.jaar)}`],
      [`Boekjaar ${jr.status}`],
      [],
      kop(jr),
      ...groepRijen(jr.activa, jr),
      ...groepRijen(jr.passiva, jr),
      ...groepRijen(jr.eigenVermogen, jr),
      // Het resultaat staat op de balans omdat het vóór het afsluiten nog niet
      // naar het eigen vermogen is geboekt; zonder deze regel telt de balans
      // voor de lezer niet op. Zie de kop van de service.
      ['', 'Resultaat boekjaar', euro(jr.resultaatCent)],
      ['', jr.inBalans ? 'Balans sluit' : 'LET OP: balans sluit niet'],
    ],
  };

  const resultaat: Blad = {
    naam: 'Baten en lasten',
    rijen: [
      [`Staat van baten en lasten ${jr.vveNaam} — ${String(jr.jaar)}`],
      [],
      kop(jr),
      ...groepRijen(jr.baten, jr),
      ...groepRijen(jr.lasten, jr),
      [
        '',
        'Resultaat',
        euro(jr.resultaatCent),
        ...(jr.vorigJaar !== null
          ? [jr.resultaatVorigJaarCent === null ? null : euro(jr.resultaatVorigJaarCent)]
          : []),
        ...(jr.heeftBegroting
          ? [jr.resultaatBegrootCent === null ? null : euro(jr.resultaatBegrootCent)]
          : []),
      ],
    ],
  };

  return bouwXlsx([balans, resultaat]);
}

/** Bedrag als `1.234,56` — Nederlandse notatie, voor de tekst- en PDF-vorm. */
export function euroTekst(centen: number): string {
  const negatief = centen < 0;
  const abs = Math.abs(centen);
  const heel = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${negatief ? '-' : ''}${heel},${rest}`;
}

/**
 * De jaarrekening als PDF: balans en staat van baten en lasten onder elkaar,
 * met dezelfde kolommen als de XLSX. Loopt over meerdere pagina's zodra de
 * regels niet passen — een VvE met een uitgebreid schema haalt één pagina niet.
 */
export function bouwJaarrekeningPdf(jr: Jaarrekening): Buffer {
  const blad = new PaginaOpbouw();
  // Kolomposities in punten; de bedragen staan rechts uitgelijnd op hun x.
  const xNummer = 56;
  const xNaam = 100;
  const xDit = 330;
  const xVorig = 420;
  const xBegroot = 505;

  const kopregel = (): void => {
    const stukken = [
      { tekst: 'Nr', x: xNummer, font: 'Helvetica-Bold' as const, grootte: 9 },
      { tekst: 'Omschrijving', x: xNaam, font: 'Helvetica-Bold' as const, grootte: 9 },
      { tekst: String(jr.jaar), x: xDit, font: 'Helvetica-Bold' as const, grootte: 9 },
    ];
    if (jr.vorigJaar !== null) {
      stukken.push({
        tekst: String(jr.vorigJaar),
        x: xVorig,
        font: 'Helvetica-Bold' as const,
        grootte: 9,
      });
    }
    if (jr.heeftBegroting) {
      stukken.push({
        tekst: 'Begroot',
        x: xBegroot,
        font: 'Helvetica-Bold' as const,
        grootte: 9,
      });
    }
    blad.kolommen(stukken);
  };

  const groepOpPapier = (groep: JaarrekeningGroep): void => {
    blad.ruimte(6);
    blad.regel(groep.titel, { font: 'Helvetica-Bold', grootte: 11 });
    for (const r of groep.regels) {
      const stukken = [
        { tekst: r.nummer, x: xNummer, grootte: 9 },
        { tekst: r.naam, x: xNaam, grootte: 9 },
        { tekst: euroTekst(r.bedragCent), x: xDit, grootte: 9 },
      ];
      if (jr.vorigJaar !== null) {
        stukken.push({
          tekst: r.vorigJaarCent === null ? '-' : euroTekst(r.vorigJaarCent),
          x: xVorig,
          grootte: 9,
        });
      }
      if (jr.heeftBegroting) {
        stukken.push({
          tekst: r.begrootCent === null ? '-' : euroTekst(r.begrootCent),
          x: xBegroot,
          grootte: 9,
        });
      }
      blad.kolommen(stukken, 12);
    }
    const totaal = [
      { tekst: '', x: xNummer, grootte: 9 },
      {
        tekst: `Totaal ${groep.titel.toLowerCase()}`,
        x: xNaam,
        font: 'Helvetica-Bold' as const,
        grootte: 9,
      },
      { tekst: euroTekst(groep.totaalCent), x: xDit, font: 'Helvetica-Bold' as const, grootte: 9 },
    ];
    if (jr.vorigJaar !== null) {
      totaal.push({
        tekst: groep.totaalVorigJaarCent === null ? '-' : euroTekst(groep.totaalVorigJaarCent),
        x: xVorig,
        font: 'Helvetica-Bold' as const,
        grootte: 9,
      });
    }
    if (jr.heeftBegroting) {
      totaal.push({
        tekst: groep.totaalBegrootCent === null ? '-' : euroTekst(groep.totaalBegrootCent),
        x: xBegroot,
        font: 'Helvetica-Bold' as const,
        grootte: 9,
      });
    }
    blad.kolommen(totaal);
  };

  blad.regel(`Jaarrekening ${jr.vveNaam}`, { font: 'Helvetica-Bold', grootte: 16 });
  blad.regel(`Boekjaar ${String(jr.jaar)} (${jr.status})`, { grootte: 10 });
  blad.ruimte(8);

  blad.regel('Balans', { font: 'Helvetica-Bold', grootte: 13 });
  kopregel();
  groepOpPapier(jr.activa);
  groepOpPapier(jr.passiva);
  groepOpPapier(jr.eigenVermogen);
  blad.ruimte(4);
  blad.regel(`Resultaat boekjaar: ${euroTekst(jr.resultaatCent)}`, { font: 'Helvetica-Bold' });
  // De lezer hoort te weten of dit stuk klopt; een stille onbalans in een
  // document dat naar de ALV gaat is erger dan een lelijke waarschuwing.
  blad.regel(
    jr.inBalans
      ? 'Balans sluit: activa = passiva + eigen vermogen + resultaat.'
      : 'LET OP: de balans sluit niet. Neem contact op met de beheerder.',
    { grootte: 9 },
  );

  blad.ruimte(14);
  blad.regel('Staat van baten en lasten', { font: 'Helvetica-Bold', grootte: 13 });
  kopregel();
  groepOpPapier(jr.baten);
  groepOpPapier(jr.lasten);
  blad.ruimte(4);
  blad.regel(`Resultaat: ${euroTekst(jr.resultaatCent)}`, { font: 'Helvetica-Bold' });

  return blad.bytes();
}
