/**
 * Minimale XML-lezer — dependency-vrij (blok B02, spec §7.2/§10).
 *
 * De spec wijst `fast-xml-parser` aan in de stacktabel, maar zegt er in
 * dezelfde adem bij dat de CAMT- en MT940-verwerking als **eigen domeincode**
 * behandeld moet worden en niet als afhankelijkheid (§10, "Eén eerlijk zwak
 * punt van deze stack"). Daar komt bij dat `packages/domein` per §7.2 puur is:
 * geen NestJS, geen database — en tot nu toe ook geen enkele afhankelijkheid.
 * Een bankafschrift is bovendien geen willekeurige XML maar een strak
 * omschreven document; wat hier nodig is, is een boom van elementen met tekst.
 *
 * **Wat deze lezer wél doet:** elementen, attributen, tekst, zelfsluitende
 * tags, commentaar, de XML-declaratie, en de vijf voorgedefinieerde entiteiten
 * plus numerieke verwijzingen.
 *
 * **Wat hij bewust níet doet:** DTD's, externe entiteiten, namespaces als
 * eigen begrip (prefixen worden van de naam gestript), processing instructions
 * met betekenis. Het weglaten van externe entiteiten is geen gemak maar
 * veiligheid: een bankbestand is invoer van buiten, en een parser die
 * entiteiten uit bestanden of URL's oplost is een XXE-gat.
 */

export interface XmlElement {
  readonly naam: string;
  readonly attributen: Readonly<Record<string, string>>;
  readonly kinderen: readonly XmlElement[];
  /** De directe tekstinhoud, aaneengeplakt en getrimd. */
  readonly tekst: string;
}

export class XmlFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'XmlFout';
  }
}

const ENTITEITEN: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Zet entiteiten om. Onbekende namen blijven staan — niets verzinnen. */
function ontsnap(tekst: string): string {
  return tekst.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (heel, naam: string) => {
    if (naam.startsWith('#x') || naam.startsWith('#X')) {
      const code = Number.parseInt(naam.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : heel;
    }
    if (naam.startsWith('#')) {
      const code = Number.parseInt(naam.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : heel;
    }
    return ENTITEITEN[naam] ?? heel;
  });
}

/** `camt:Ntry` en `Ntry` zijn hetzelfde element; de prefix gaat eraf. */
function zonderPrefix(naam: string): string {
  const dubbelepunt = naam.indexOf(':');
  return dubbelepunt === -1 ? naam : naam.slice(dubbelepunt + 1);
}

interface Bouwsel {
  naam: string;
  attributen: Record<string, string>;
  kinderen: XmlElement[];
  tekst: string[];
}

function afronden(b: Bouwsel): XmlElement {
  return {
    naam: b.naam,
    attributen: b.attributen,
    kinderen: b.kinderen,
    tekst: b.tekst.join('').trim(),
  };
}

function leesAttributen(ruw: string): Record<string, string> {
  const uit: Record<string, string> = {};
  const patroon = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let treffer: RegExpExecArray | null = patroon.exec(ruw);
  while (treffer !== null) {
    const naam = zonderPrefix(treffer[1] ?? '');
    uit[naam] = ontsnap(treffer[3] ?? treffer[4] ?? '');
    treffer = patroon.exec(ruw);
  }
  return uit;
}

/**
 * Leest een XML-document en geeft het wortelelement terug.
 *
 * Werkt met één doorloop en een stapel; dat is genoeg voor een afschrift van
 * enkele duizenden regels en houdt het geheugengebruik evenredig aan de diepte
 * in plaats van aan de bestandsgrootte maal een objectboom per token.
 */
export function leesXml(bron: string): XmlElement {
  const stapel: Bouwsel[] = [];
  let wortel: XmlElement | null = null;
  let i = 0;

  while (i < bron.length) {
    const open = bron.indexOf('<', i);
    if (open === -1) break;

    if (open > i) {
      const stuk = bron.slice(i, open);
      stapel[stapel.length - 1]?.tekst.push(ontsnap(stuk));
    }

    // Commentaar, CDATA, declaratie en processing instructions overslaan.
    if (bron.startsWith('<!--', open)) {
      const eind = bron.indexOf('-->', open);
      if (eind === -1) throw new XmlFout('Commentaar zonder afsluiting.');
      i = eind + 3;
      continue;
    }
    if (bron.startsWith('<![CDATA[', open)) {
      const eind = bron.indexOf(']]>', open);
      if (eind === -1) throw new XmlFout('CDATA zonder afsluiting.');
      stapel[stapel.length - 1]?.tekst.push(bron.slice(open + 9, eind));
      i = eind + 3;
      continue;
    }
    if (bron.startsWith('<?', open) || bron.startsWith('<!', open)) {
      const eind = bron.indexOf('>', open);
      if (eind === -1) throw new XmlFout('Declaratie zonder afsluiting.');
      i = eind + 1;
      continue;
    }

    const sluit = bron.indexOf('>', open);
    if (sluit === -1) throw new XmlFout('Tag zonder afsluiting.');
    const inhoud = bron.slice(open + 1, sluit);

    if (inhoud.startsWith('/')) {
      const naam = zonderPrefix(inhoud.slice(1).trim());
      const huidig = stapel.pop();
      if (huidig === undefined || huidig.naam !== naam) {
        throw new XmlFout(`Sluittag </${naam}> past niet op <${huidig?.naam ?? '?'}>.`);
      }
      const klaar = afronden(huidig);
      if (stapel.length === 0) wortel = klaar;
      else stapel[stapel.length - 1]?.kinderen.push(klaar);
      i = sluit + 1;
      continue;
    }

    const zelfsluitend = inhoud.endsWith('/');
    const kern = zelfsluitend ? inhoud.slice(0, -1) : inhoud;
    const spatie = kern.search(/\s/);
    const naam = zonderPrefix((spatie === -1 ? kern : kern.slice(0, spatie)).trim());
    const attributen = spatie === -1 ? {} : leesAttributen(kern.slice(spatie));

    if (zelfsluitend) {
      const klaar: XmlElement = { naam, attributen, kinderen: [], tekst: '' };
      if (stapel.length === 0) wortel = klaar;
      else stapel[stapel.length - 1]?.kinderen.push(klaar);
    } else {
      stapel.push({ naam, attributen, kinderen: [], tekst: [] });
    }
    i = sluit + 1;
  }

  if (stapel.length > 0) {
    throw new XmlFout(`Element <${stapel[stapel.length - 1]?.naam ?? '?'}> is niet gesloten.`);
  }
  if (wortel === null) throw new XmlFout('Geen XML-element gevonden.');
  return wortel;
}

/**
 * Alle directe kinderen met deze naam. Accepteert `null` als ouder: dan is het
 * antwoord leeg. Dat scheelt bij elke aanroep een nullcheck en leest als de
 * XML zelf.
 */
export function kinderen(element: XmlElement | null, naam: string): readonly XmlElement[] {
  return element === null ? [] : element.kinderen.filter((k) => k.naam === naam);
}

/** Het eerste directe kind met deze naam, of `null`. */
export function kind(element: XmlElement | null, naam: string): XmlElement | null {
  return element === null ? null : (element.kinderen.find((k) => k.naam === naam) ?? null);
}

/**
 * Volgt een pad van elementnamen en geeft het element aan het eind.
 *
 * `pad(stmt, 'Acct', 'Id', 'IBAN')` leest als de XML zelf; een keten van
 * `kind(kind(kind(...)))` met nullchecks leest als niets.
 */
export function pad(element: XmlElement | null, ...namen: readonly string[]): XmlElement | null {
  let huidig = element;
  for (const naam of namen) {
    if (huidig === null) return null;
    huidig = kind(huidig, naam);
  }
  return huidig;
}

/** De tekst op een pad, of `null` als het pad niet bestaat of leeg is. */
export function tekstOp(element: XmlElement | null, ...namen: readonly string[]): string | null {
  const gevonden = pad(element, ...namen);
  if (gevonden === null || gevonden.tekst === '') return null;
  return gevonden.tekst;
}
