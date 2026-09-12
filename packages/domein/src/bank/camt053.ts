/**
 * CAMT.053-parser — blok B02 (spec §10, AC7.1–7.3, tests #11–12).
 *
 * Leest een dagafschrift (camt.053.001.02 en .08) en levert genormaliseerde
 * bankmutaties plus de begin- en eindsaldi. Pure functie: tekst in, gegevens
 * uit. Geen database, geen bestandssysteem — dat past bij §7.2 en maakt hem
 * toetsbaar tegen echte, geanonimiseerde bestanden.
 *
 * **Bedragen in centen.** De XML draagt `1234.56`; hier wordt dat 123456. De
 * omrekening gaat over de tekst en niet via `parseFloat`, want `0.1 + 0.2`
 * hoort in een financiële toepassing nergens voor te komen (§5.1).
 *
 * **Teken.** CAMT drukt richting uit in `CdtDbtInd` (`CRDT` bij) en `DBIT`
 * (af). Hier wordt dat één getal: bij is positief, af is negatief. Eén veld met
 * een teken is minder foutgevoelig dan een bedrag plus een losse richtingvlag
 * die iemand kan vergeten.
 *
 * **De duplicaatsleutel.** AC7.2 vraagt een hash over rekening, boekdatum,
 * bedrag, tegenrekening, omschrijving en volgnummer. Die velden worden hier tot
 * één tekst samengevoegd; het hashen zelf gebeurt in de API-laag. Zo blijft dit
 * pakket vrij van `node:crypto` en is de sleutel in een test leesbaar te
 * controleren.
 */

import { kind, kinderen, leesXml, pad, tekstOp, type XmlElement } from './xml.js';

export class CamtFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'CamtFout';
  }
}

export interface Bankmutatie {
  /** IBAN van de eigen rekening waarop dit afschrift staat. */
  readonly rekeningIban: string;
  readonly boekdatum: string;
  readonly valutadatum: string | null;
  /** Positief = bij, negatief = af. */
  readonly bedragCent: number;
  readonly munt: string;
  readonly tegenrekeningIban: string | null;
  readonly tegenpartijNaam: string | null;
  readonly omschrijving: string;
  readonly eindToEindId: string | null;
  /** Bankreferentie van de post; onderdeel van de duplicaatsleutel. */
  readonly bankreferentie: string | null;
  /** Volgnummer binnen het afschrift, vanaf 1 — het laatste redmiddel. */
  readonly volgnummer: number;
  /** Samengestelde sleutel voor duplicaatdetectie (AC7.2). */
  readonly duplicaatSleutel: string;
}

export interface Camt053Afschrift {
  readonly rekeningIban: string;
  readonly munt: string;
  /** Afschriftnummer van de bank (`Stmt/Id` of `LglSeqNb`). */
  readonly afschriftId: string | null;
  readonly beginsaldoCent: number;
  readonly eindsaldoCent: number;
  readonly beginsaldoDatum: string | null;
  readonly eindsaldoDatum: string | null;
  readonly mutaties: readonly Bankmutatie[];
}

/** `1234.56` → 123456, over de tekst, zonder drijvende komma. */
export function bedragNaarCenten(ruw: string): number {
  const schoon = ruw.trim().replace(/\s/g, '');
  const treffer = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(schoon);
  if (treffer === null) throw new CamtFout(`Onleesbaar bedrag: ${JSON.stringify(ruw)}`);
  const teken = treffer[1] === '-' ? -1 : 1;
  const heel = Number.parseInt(treffer[2] ?? '0', 10);
  const decimalen = (treffer[3] ?? '').padEnd(2, '0');
  return teken * (heel * 100 + Number.parseInt(decimalen, 10));
}

/** `CRDT` → +1, `DBIT` → −1. */
function richting(element: XmlElement | null, waar: string): number {
  const ind = tekstOp(element, 'CdtDbtInd');
  if (ind === 'CRDT') return 1;
  if (ind === 'DBIT') return -1;
  throw new CamtFout(`Ontbrekende of onbekende CdtDbtInd bij ${waar}.`);
}

/** Een datum staat als `Dt` (kalenderdag) of `DtTm` (tijdstip); wij willen de dag. */
function datumVan(element: XmlElement | null): string | null {
  const dag = tekstOp(element, 'Dt');
  if (dag !== null) return dag.slice(0, 10);
  const tijdstip = tekstOp(element, 'DtTm');
  return tijdstip === null ? null : tijdstip.slice(0, 10);
}

/**
 * Alle `Ustrd`-regels onder een post, aaneengeplakt.
 *
 * Banken knippen een lange omschrijving over meerdere `Ustrd`-elementen; wie
 * alleen de eerste leest, mist het betalingskenmerk dat er net achter stond —
 * en dat is precies waarop B05 straks aflettert.
 */
function omschrijvingVan(ntry: XmlElement, details: readonly XmlElement[]): string {
  const stukken: string[] = [];
  const verzamel = (element: XmlElement | null): void => {
    const rmt = kind(element, 'RmtInf');
    if (rmt === null) return;
    for (const u of kinderen(rmt, 'Ustrd')) if (u.tekst !== '') stukken.push(u.tekst);
    const gestructureerd = kind(rmt, 'Strd');
    const ref = tekstOp(gestructureerd, 'CdtrRefInf', 'Ref');
    if (ref !== null) stukken.push(ref);
  };
  for (const d of details) verzamel(d);
  if (stukken.length === 0) verzamel(ntry);
  if (stukken.length === 0) {
    const aanvullend = tekstOp(ntry, 'AddtlNtryInf');
    if (aanvullend !== null) stukken.push(aanvullend);
  }
  return stukken.join(' ').replace(/\s+/g, ' ').trim();
}

/** De tegenpartij hangt aan de andere kant dan wijzelf. */
function tegenpartij(
  details: readonly XmlElement[],
  bijOns: boolean,
): { iban: string | null; naam: string | null } {
  for (const d of details) {
    const partijen = kind(d, 'RltdPties');
    if (partijen === null) continue;
    // Bij een bijschrijving is de tegenpartij de debiteur, bij een afschrijving
    // de crediteur. Andersom lezen levert onze eigen naam op.
    const rol = bijOns ? 'Dbtr' : 'Cdtr';
    const rekening = bijOns ? 'DbtrAcct' : 'CdtrAcct';
    const naam = tekstOp(partijen, rol, 'Nm') ?? tekstOp(partijen, rol, 'Pty', 'Nm');
    const iban = tekstOp(partijen, rekening, 'Id', 'IBAN');
    if (naam !== null || iban !== null) return { iban, naam };
  }
  return { iban: null, naam: null };
}

function saldoVan(stmt: XmlElement, codes: readonly string[]): XmlElement | null {
  for (const code of codes) {
    for (const bal of kinderen(stmt, 'Bal')) {
      const cd = tekstOp(bal, 'Tp', 'CdOrPrtry', 'Cd');
      if (cd === code) return bal;
    }
  }
  return null;
}

function saldoBedrag(bal: XmlElement | null, waar: string): number {
  if (bal === null) throw new CamtFout(`Saldo ${waar} ontbreekt in het afschrift.`);
  const amt = kind(bal, 'Amt');
  if (amt === null) throw new CamtFout(`Saldo ${waar} heeft geen bedrag.`);
  return richting(bal, `saldo ${waar}`) * bedragNaarCenten(amt.tekst);
}

/**
 * Leest één CAMT.053-bestand. Een bestand met meerdere `Stmt`-blokken levert
 * meerdere afschriften; banken zetten er soms meer dagen in één bestand.
 */
export function leesCamt053(xml: string): readonly Camt053Afschrift[] {
  const wortel = leesXml(xml);
  const stmts = kinderen(pad(wortel, 'BkToCstmrStmt') ?? wortel, 'Stmt');
  if (stmts.length === 0) {
    throw new CamtFout('Geen Stmt-element gevonden; is dit wel een CAMT.053-bestand?');
  }

  return stmts.map((stmt) => {
    const rekeningIban = tekstOp(stmt, 'Acct', 'Id', 'IBAN');
    if (rekeningIban === null) {
      throw new CamtFout('Het afschrift noemt geen IBAN van de eigen rekening.');
    }
    const opbd = saldoVan(stmt, ['OPBD', 'PRCD']);
    const clbd = saldoVan(stmt, ['CLBD', 'CLAV']);
    const beginsaldo = saldoBedrag(opbd, 'begin (OPBD)');
    const eindsaldo = saldoBedrag(clbd, 'eind (CLBD)');
    const munt = kind(opbd, 'Amt')?.attributen['Ccy'] ?? 'EUR';

    const mutaties: Bankmutatie[] = [];
    let volgnummer = 0;

    for (const ntry of kinderen(stmt, 'Ntry')) {
      volgnummer += 1;
      const amt = kind(ntry, 'Amt');
      if (amt === null) throw new CamtFout(`Post ${String(volgnummer)} heeft geen bedrag.`);
      const teken = richting(ntry, `post ${String(volgnummer)}`);
      const bedragCent = teken * bedragNaarCenten(amt.tekst);
      const boekdatum = datumVan(kind(ntry, 'BookgDt'));
      if (boekdatum === null) {
        throw new CamtFout(`Post ${String(volgnummer)} heeft geen boekdatum.`);
      }
      const details = kinderen(kind(ntry, 'NtryDtls') ?? ntry, 'TxDtls');
      const partij = tegenpartij(details, teken > 0);
      const omschrijving = omschrijvingVan(ntry, details);
      const eindToEind =
        details.map((d) => tekstOp(d, 'Refs', 'EndToEndId')).find((x) => x !== null) ?? null;
      const bankreferentie = tekstOp(ntry, 'AcctSvcrRef');

      mutaties.push({
        rekeningIban,
        boekdatum,
        valutadatum: datumVan(kind(ntry, 'ValDt')),
        bedragCent,
        munt: amt.attributen['Ccy'] ?? munt,
        tegenrekeningIban: partij.iban,
        tegenpartijNaam: partij.naam,
        omschrijving,
        eindToEindId: eindToEind === '' ? null : eindToEind,
        bankreferentie,
        volgnummer,
        // AC7.2: rekening, boekdatum, bedrag, tegenrekening, omschrijving en
        // volgnummer. De bankreferentie gaat mee als hij er is: die maakt twee
        // identieke betalingen op dezelfde dag alsnog onderscheidbaar.
        duplicaatSleutel: [
          rekeningIban,
          boekdatum,
          String(bedragCent),
          partij.iban ?? '',
          omschrijving,
          bankreferentie ?? String(volgnummer),
        ].join('|'),
      });
    }

    return {
      rekeningIban,
      munt,
      afschriftId: tekstOp(stmt, 'Id') ?? tekstOp(stmt, 'LglSeqNb'),
      beginsaldoCent: beginsaldo,
      eindsaldoCent: eindsaldo,
      beginsaldoDatum: datumVan(kind(opbd, 'Dt')),
      eindsaldoDatum: datumVan(kind(clbd, 'Dt')),
      mutaties,
    };
  });
}

/**
 * Controleert of het afschrift intern klopt: beginsaldo plus de posten is het
 * eindsaldo.
 *
 * Dit is niet hetzelfde als de saldocontinuïteit van AC7.3 — die vergelijkt
 * dít bestand met het vórige. Deze toets kijkt binnen één bestand, en vangt een
 * afgekapt of half gedownload afschrift vóórdat het de administratie in gaat.
 */
export function afschriftSluit(afschrift: Camt053Afschrift): {
  sluit: boolean;
  verschilCent: number;
} {
  const som = afschrift.mutaties.reduce((s, m) => s + m.bedragCent, 0);
  const verwacht = afschrift.beginsaldoCent + som;
  return {
    sluit: verwacht === afschrift.eindsaldoCent,
    verschilCent: afschrift.eindsaldoCent - verwacht,
  };
}
