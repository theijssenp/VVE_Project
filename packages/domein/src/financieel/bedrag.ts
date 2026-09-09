/**
 * `Bedrag` — geld als waardetype, uitsluitend hele centen (spec §5.1, §7.3).
 *
 * PURE TypeScript: geen I/O, geen Date, geen NestJS. Er is geen constructor die
 * een float accepteert; rekenkunde loopt uitsluitend via de methodes. De
 * presentatienotatie (§5.1) is "€ 1.234,56"; invoer accepteert "1.234,56",
 * "1234.56" en gehele getallen.
 */

/** Grens waarbinnen gehele centen exact zijn in IEEE-754 doubles. */
const MAX_VEILIG = Number.MAX_SAFE_INTEGER;

/** Foutklasse voor alle Bedrag-fouten (naam volgt spec §7.3). */
export class BedragFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'BedragFout';
  }
}

/**
 * Geld. Uitsluitend hele centen; de constructor is privé zodat geen enkel
 * pad een float of NaN binnenlaat (spec §7.3).
 */
export class Bedrag {
  private constructor(readonly centen: number) {
    if (!Number.isSafeInteger(centen)) {
      throw new BedragFout(`Geen geheel aantal centen: ${String(centen)}`);
    }
  }

  static vanCenten(c: number): Bedrag {
    return new Bedrag(c);
  }

  /** "1.234,56", "1234.56", "1234" en negatieve varianten. */
  static vanInvoer(s: string): Bedrag {
    return new Bedrag(parseInvoer(s));
  }

  static nul(): Bedrag {
    return new Bedrag(0);
  }

  plus(b: Bedrag): Bedrag {
    const som = this.centen + b.centen;
    if (!Number.isSafeInteger(som)) {
      throw new BedragFout('Optelling valt buiten de veilige integerruimte');
    }
    return new Bedrag(som);
  }

  min(b: Bedrag): Bedrag {
    const verschil = this.centen - b.centen;
    if (!Number.isSafeInteger(verschil)) {
      throw new BedragFout('Verschil valt buiten de veilige integerruimte');
    }
    return new Bedrag(verschil);
  }

  /** Factor moet geheel zijn (spec §7.3) — 1,5× een bedrag is geen geldige operatie. */
  maal(factor: number): Bedrag {
    if (!Number.isInteger(factor)) {
      throw new BedragFout(`Factor moet geheel zijn: ${String(factor)}`);
    }
    const product = this.centen * factor;
    if (!Number.isSafeInteger(product)) {
      throw new BedragFout(`Product valt buiten de veilige integerruimte: ${String(product)}`);
    }
    return new Bedrag(product);
  }

  isNegatief(): boolean {
    return this.centen < 0;
  }

  /** "€ 1.234,56" (§5.1: duizendtal met punt, decimaal met komma). */
  formatteer(): string {
    return formatteerEuro(this.centen);
  }
}

/** Klassen-grens waarbinnen centen exact zijn (voor externe checks). */
export const MAX_CENTEN = MAX_VEILIG;

/**
 * Formateert centen als €-bedrag: duizendtallen met punt, decimaal met komma,
 * voorvoegsel "€ ". Negatief: "-€ 1.234,56".
 */
export function formatteerEuro(centen: number): string {
  if (!Number.isSafeInteger(centen)) {
    throw new BedragFout(`Geld is uitsluitend hele centen; ontvangen: ${String(centen)}`);
  }
  const teken = centen < 0 ? '-' : '';
  const abs = Math.abs(centen);
  const euro = Math.floor(abs / 100);
  const rest = abs % 100;
  const duizendtallen = euro.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${teken}€ ${duizendtallen},${String(rest).padStart(2, '0')}`;
}

/**
 * Parseert bedraginvoer: "1.234,56" (nl-NL, punt als duizendtal), "1234.56"
 * (neutrale decimale punt), "1234" (heel eurobedrag) en negatieve varianten.
 * Hoogstens twee decimalen; een punt zonder komma is een decimale punt —
 * meerdere punten zónder komma zijn dubbelzinnig en worden geweigerd.
 */
export function parseInvoer(s: string): number {
  const getrimd = s.trim();
  if (getrimd === '') {
    throw new BedragFout('Lege invoer is geen bedrag');
  }
  const heeftPunt = getrimd.includes('.');
  const heeftKomma = getrimd.includes(',');
  let genormaliseerd: string;
  if (heeftPunt && heeftKomma) {
    // "1.234,56": punt is duizendtal, komma decimaal.
    genormaliseerd = getrimd.replace(/\./g, '').replace(',', '.');
  } else if (heeftKomma) {
    if (getrimd.split(',').length > 2) {
      throw new BedragFout(`Meer dan één decimaalscheiding: ${getrimd}`);
    }
    genormaliseerd = getrimd.replace(',', '.');
  } else {
    if (getrimd.split('.').length > 2) {
      throw new BedragFout(
        `Dubbelzinnige notatie (meerdere punten, geen komma): ${getrimd}. Gebruik "1.234,56" of "1234.56".`,
      );
    }
    genormaliseerd = getrimd;
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(genormaliseerd)) {
    throw new BedragFout(
      `Niet-herkenbare bedragnotatie: ${getrimd}. Verwacht "1.234,56", "1234.56" of een geheel getal.`,
    );
  }
  const negatief = genormaliseerd.startsWith('-');
  const abs = negatief ? genormaliseerd.slice(1) : genormaliseerd;
  const [heel = '0', dec = ''] = abs.split('.');
  const centen = Number(heel) * 100 + Number(dec.padEnd(2, '0').slice(0, 2));
  const totaal = negatief ? -centen : centen;
  if (!Number.isSafeInteger(totaal)) {
    throw new BedragFout(`Bedrag buiten de veilige integerruimte: ${getrimd}`);
  }
  return totaal;
}