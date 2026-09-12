/**
 * Tests — CAMT.053-parser (B02, AC7.1–7.2, test #11-voorbereiding).
 *
 * Getoetst tegen een geanonimiseerd bestand in de vorm die de Nederlandse
 * banken aanleveren: meerdere `Ustrd`-regels, een post zonder `TxDtls`, en een
 * bij- én afschrijving. Dat laatste is belangrijk, omdat de tegenpartij bij een
 * bijschrijving aan de debiteurkant hangt en bij een afschrijving aan de
 * crediteurkant — wie één richting test, leest de andere verkeerd uit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { afschriftSluit, bedragNaarCenten, CamtFout, leesCamt053 } from './camt053.js';
import { leesXml, XmlFout } from './xml.js';

// `packages/domein` bouwt naar CommonJS, dus `import.meta` mag hier niet;
// `__dirname` is de vorm die in beide werelden bestaat.
const voorbeeld = readFileSync(join(__dirname, 'fixtures', 'camt053-voorbeeld.xml'), 'utf8');

describe('Bedragen (§5.1: alles in centen)', () => {
  it('rekent over de tekst, niet via drijvende komma', () => {
    expect(bedragNaarCenten('1234.56')).toBe(123_456);
    expect(bedragNaarCenten('0.01')).toBe(1);
    expect(bedragNaarCenten('0.1')).toBe(10);
    expect(bedragNaarCenten('1500')).toBe(150_000);
    expect(bedragNaarCenten('1234,56')).toBe(123_456);
    // De klassieker die met floats misgaat.
    expect(bedragNaarCenten('0.29')).toBe(29);
  });

  it('weigert wat geen bedrag is in plaats van er nul van te maken', () => {
    expect(() => bedragNaarCenten('twaalf')).toThrow(CamtFout);
    expect(() => bedragNaarCenten('1.234')).toThrow(CamtFout);
    expect(() => bedragNaarCenten('')).toThrow(CamtFout);
  });
});

describe('XML-lezer', () => {
  it('leest attributen, zelfsluitende tags en entiteiten', () => {
    const wortel = leesXml('<a x="1"><b/><c>A &amp; B</c></a>');
    expect(wortel.naam).toBe('a');
    expect(wortel.attributen['x']).toBe('1');
    expect(wortel.kinderen.map((k) => k.naam)).toEqual(['b', 'c']);
    expect(wortel.kinderen[1]?.tekst).toBe('A & B');
  });

  it('strookt prefixen: camt:Ntry en Ntry zijn hetzelfde element', () => {
    const wortel = leesXml('<camt:Doc xmlns:camt="x"><camt:Ntry>1</camt:Ntry></camt:Doc>');
    expect(wortel.naam).toBe('Doc');
    expect(wortel.kinderen[0]?.naam).toBe('Ntry');
  });

  it('weigert een niet-gesloten element in plaats van half te parsen', () => {
    expect(() => leesXml('<a><b></a>')).toThrow(XmlFout);
    expect(() => leesXml('<a>')).toThrow(XmlFout);
  });
});

describe('CAMT.053 (AC7.1)', () => {
  it('leest rekening, saldi en alle posten', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    if (afschrift === undefined) throw new Error('geen afschrift');

    expect(afschrift.rekeningIban).toBe('NL02ABNA0123456789');
    expect(afschrift.munt).toBe('EUR');
    expect(afschrift.afschriftId).toBe('2026031');
    expect(afschrift.beginsaldoCent).toBe(150_000);
    expect(afschrift.eindsaldoCent).toBe(163_750);
    expect(afschrift.mutaties).toHaveLength(3);
  });

  it('geeft bij positief en af negatief, uit CdtDbtInd', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    const [bij, af] = afschrift?.mutaties ?? [];
    expect(bij?.bedragCent).toBe(21_250);
    expect(af?.bedragCent).toBe(-7_500);
  });

  it('leest de tegenpartij aan de juiste kant van de transactie', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    const [bij, af] = afschrift?.mutaties ?? [];
    // Bijschrijving: de tegenpartij is de debiteur.
    expect(bij?.tegenpartijNaam).toBe('J. de Vries');
    expect(bij?.tegenrekeningIban).toBe('NL91INGB0001234567');
    // Afschrijving: de tegenpartij is de crediteur.
    expect(af?.tegenpartijNaam).toBe('Liftservice Noord B.V.');
    expect(af?.tegenrekeningIban).toBe('NL44RABO0987654321');
  });

  it('plakt meerdere Ustrd-regels aaneen — het kenmerk staat vaak in de tweede', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    const bij = afschrift?.mutaties[0];
    expect(bij?.omschrijving).toBe('Bijdrage maart 2026 kenmerk NOTA2026000123');
    expect(bij?.eindToEindId).toBe('NOTA2026000123');
  });

  it('valt terug op AddtlNtryInf als er geen RmtInf is', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    const derde = afschrift?.mutaties[2];
    expect(derde?.omschrijving).toBe('Kosten betalingsverkeer & pas');
    expect(derde?.tegenpartijNaam).toBeNull();
  });

  it('AC7.2: de duplicaatsleutel dekt rekening, datum, bedrag, tegenrekening en referentie', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    const bij = afschrift?.mutaties[0];
    expect(bij?.duplicaatSleutel).toContain('NL02ABNA0123456789');
    expect(bij?.duplicaatSleutel).toContain('2026-03-01');
    expect(bij?.duplicaatSleutel).toContain('21250');
    expect(bij?.duplicaatSleutel).toContain('NL91INGB0001234567');
    expect(bij?.duplicaatSleutel).toContain('REF-0001');

    // Twee keer hetzelfde bestand lezen levert dezelfde sleutels op; dáár
    // steunt test #11 op.
    const [opnieuw] = leesCamt053(voorbeeld);
    expect(opnieuw?.mutaties.map((m) => m.duplicaatSleutel)).toEqual(
      afschrift?.mutaties.map((m) => m.duplicaatSleutel),
    );
  });

  it('het afschrift sluit: beginsaldo plus de posten is het eindsaldo', () => {
    const [afschrift] = leesCamt053(voorbeeld);
    if (afschrift === undefined) throw new Error('geen afschrift');
    const uit = afschriftSluit(afschrift);
    expect(uit.sluit).toBe(true);
    expect(uit.verschilCent).toBe(0);
  });

  it('een afgekapt afschrift wordt betrapt in plaats van stil ingelezen', () => {
    // Eén post weggehaald: het eindsaldo klopt dan niet meer met de posten.
    // Knippen op de blokken zelf in plaats van met één grote regex: die zou
    // vanaf de eerste <Ntry> matchen en er twee tegelijk weghalen.
    const blokken = voorbeeld.split('<Ntry>');
    const gehavend = blokken
      .filter((blok, i) => i === 0 || !blok.includes('REF-0002'))
      .join('<Ntry>');
    const [afschrift] = leesCamt053(gehavend);
    if (afschrift === undefined) throw new Error('geen afschrift');
    expect(afschrift.mutaties).toHaveLength(2);
    const uit = afschriftSluit(afschrift);
    expect(uit.sluit).toBe(false);
    expect(uit.verschilCent).toBe(-7_500);
  });

  it('weigert een bestand dat geen CAMT.053 is', () => {
    expect(() => leesCamt053('<Document><Iets/></Document>')).toThrow(CamtFout);
  });

  it('weigert een afschrift zonder saldi', () => {
    const zonder = voorbeeld.replace(/<Bal>[\s\S]*?<\/Bal>/g, '');
    expect(() => leesCamt053(zonder)).toThrow(CamtFout);
  });
});
