/**
 * `auth/wachtwoord` — wachtwoord-primitives (F06a, spec §7.6, §8.2).
 *
 * Een PURE module: alleen import van `argon2` (een native hashing-bibliotheek,
 * geen NestJS, geen database, geen netwerk). De domein-bans gelden niet op
 * `apps/api`, maar deze module wordt bewust nestjs-vrij gehouden zodat de
 * primitives unit-testbaar en herbruikbaar zijn — ook buiten de Nest-container.
 *
 * Dit is DEELSTUK 1 van F06: de primitieven zelf. Token-uitgifte, sessies en de
 * inlogflow (inclusief rate limiting en de constante afhandel-tijd voor corrupte
 * hashes) volgen in latere deelstukken.
 *
 * Ontwerppunten (zie `docs/besluiten.md`, F06a):
 * - Hashen/verifiëren met **argon2id** via `argon2`, met expliciete parameteren:
 *   memory 19 MiB, 2 iteraties, parallelism 1 (OWASP 2023-baseline voor
 *   CPU-/GPU-resistantie). De PHC-string die `argon2` produceert, onthoudt
 *   zelf de parameters, dus een oude hash blijft verifieerbaar na een
 *   parameter-bump.
 * - `verifieerWachtwoord` geeft bij een corrupte/ongeldige hash `false` terug
 *   i.p.v. te crashen: een ongeldige hash is per definitie "niet dit
 *   wachtwoord", en een exception zou de aanroeper dwingen elke hash te
 *   valideren vóór de check.
 * - De sterktebeoordeling gebruikt een LOKALE lijst met veelgebruikte/zwakke
 *   wachtwoorden plus een paar triviale patronen. In dit deelstuk is er géén
 *   HIBP-netwerk-API en géén zxcvbn-afhankelijkheid (die is breed en zou het
 *   kort-blijven-dienend pakkettenbestand opblazen, spec §8.2). Een vervolg
 *   naar een grotere lokale HIBP-lijst of zxcvbn is genoteerd in `besluiten.md`.
 */

import { argon2id, hash as argon2Hash, verify, type HashOptions } from 'argon2';

// ---------------------------------------------------------------------------
// Hashparameters
// ---------------------------------------------------------------------------

/**
 * Argon2id met de OWASP 2023 baselines voor interactief gebruik.
 *
 * - `type` = argon2id (beschermend tegen zowel GPU- als side-channel-aanvallen).
 * - `memoryCost` = 19 MiB (19 × 1024 KiB): de minimum die OWASP 2023 vraagt.
 * - `timeCost` = 2 iteraties: de minimum die OWASP 2023 vraagt.
 * - `parallelism` = 1: geschikt voor een single-user (inlog) context; verhoog
 *   dit pas als de server parallel capaciteit heeft en de latency dat toestaat.
 *
 * De keus staat bewust als aparte constante zodat F06b (token-uitgifte) en de
 * tests dezelfde parameters delen en de keuze in één plek te herzien is.
 */
export const HASH_PARAMS: HashOptions = {
  type: argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

/** Minimale wachtwoordlengte (spec §7.6: minimaal 12 tekens). */
export const MOINSTE_LENGTE = 12;

// ---------------------------------------------------------------------------
// Hashen en verifiëren
// ---------------------------------------------------------------------------

/**
 * Haast een wachtwoord met argon2id met de vaste {@link HASH_PARAMS}.
 *
 * Retourneert de PHC-string (bijv. `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`).
 * Deze onthoudt de parameters en is het enige wat er in de database opgeslagen
 * wordt — nooit de platte tekst. De salt en het derivation-niveau zijn
 * ingebed; er is geen externe toepassing geadviseerd voor het hashen.
 *
 * @throws als `argon2` een native foutmelding heeft (geen verwacht geval op
 *   een normale invoer; de aanroeper moet het vangen en als serverfout behandelen).
 */
export function hashWachtwoord(tekst: string): Promise<string> {
  return argon2Hash(tekst, HASH_PARAMS);
}

/**
 * Verifieert of `tekst` de hash produceert. Timing-veilig in de zin dat de
 * vergelijking binnen `argon2` constant-tijdig is.
 *
 * Bij een corrupt of ongeldig hash-formaat (bijv. `null`, leeg, of een string
 * die niet door `argon2` geparset kan worden) wordt `false` teruggegeven in
 * plaats van een throw — een ongeldige hash kan nooit "dit wachtwoord" zijn.
 * Een constant-tijdige afhandeling (één dummy-hash om het tijdsverschil te
 * minimaliseren) is een vervolgstap samen met de rate-limiter.
 *
 * @returns `true` alleen als de hash geldig is en de afgeleide sleutel gelijk is.
 */
export async function verifieerWachtwoord(tekst: string, hash: string): Promise<boolean> {
  try {
    return await verify(hash, tekst);
   } catch {
     // Ongeldige/corrupte hash: niet "dit wachtwoord", en we crashen niet.
    return false;
   }
}

// ---------------------------------------------------------------------------
// Sterktebeoordeling
// ---------------------------------------------------------------------------

/** Resultaat van {@link beoordeelWachtwoord}. */
export interface Beoordeling {
  /** `true` als er géén enkele reden is om het te weigeren. */
  readonly ok: boolean;
  /** Mens-leesbare redenen waarom het wachtwoord (nog) onvoldoende is; leeg bij `ok: true`. */
  readonly redenen: readonly string[];
}

/**
 * Ingebouwde lijst met de meest voorkomende zwakke wachtwoorden.
 *
 * Dit is publiek-bekend referentiemateriaal (analoog aan de top-100 van de
 * HIBP-list), géén eigen-geheime of account-gegevens, en mag dus veilig in de
 * repo staan (spec §8.2: "geen geheimen in de repository"). Een wachtwoord
 * dat hier exact voorkomt, is per definitie onvoldoende sterk.
 */
const ZWARTE_LIJST = new Set<string>([
  // Klassieke top-10 (frequent op het internet).
  '123456',
  '123456789',
  '12345678',
  'password',
  'qwerty',
  '12345',
  '123123',
  'admin',
  'iloveyou',
  '111111',
  // Algemene zwakke patronen / slechte keuzes.
  '1234567890',
  'abc123',
  'qwertyuiop',
  '11111111',
  '123321',
  '1234567',
  '12345678910',
  '123456789012',
  'qwertyuiopasdfgh',
  '1q2w3e4r5t',
  '1q2w3e',
  'qazwsx',
  '1qaz2wsx',
  'zaq1zaq1',
  'azerty',
  'monkey',
  'dragon',
  'letmein',
  'passw0rd',
  'master',
  'sunshine',
  'princess',
  'football',
  'welcome',
  'welcome123',
  'welcome1',
  'welkom',
  'welkom123',
  'wachtwoord',
  'wachtwoord1',
  'wo0rd',
  'secret',
  'root',
  'toor',
  'changeme',
  'changeit',
  'default',
  'test',
  'test123',
  'testing',
  'temp',
  'admin123',
  'administrator',
  'guest',
  'pass',
  'pass123',
  'p@ssw0rd',
  'superman',
  'batman',
  'batman1',
  'matrix',
  'trustno1',
  'love',
  'money',
  'summer',
  'winter',
  'spring',
  'autumn',
  'hockey',
  'baseball',
  'soccer',
  'netherlands',
  'nederland',
  '1q2w3e4r',
  'qwe123',
  'asdfgh',
  'asdf',
  'zxcvbnm',
  'asdfghjkl',
  'vve',
  'vve2025',
  'vve2026',
  'eigenaar',
  'eigendom',
  'appartement',
  'apartment',
  'woning',
  'huis',
  'vereniging',
  'bestuur',
  '10203040',
  '159357',
  '100200300',
  '112233',
  '000000',
  'aaaaaa',
  'aaaaaa1',
  'abcd1234',
  'abcdef',
  'password1',
  'password123',
  'qweasd',
  'asdfg',
  'q1w2e3r4',
  'a1b2c3',
  '1a2b3c',
  'qwerty1',
  'qwerty123',
  '12341234',
  '1234abcd',
  'abcd1234',
  '1q2w3e4r5',
  'iluvyou',
  'lovemel',
  '121212',
  '987654321',
  '0000',
  '00000',
  '0000000',
  'secret123',
  '1111111',
  '123456a',
  'a123456',
  '123456q',
  'q123456',
  '123123123',
  'qaz123',
  '123qwe',
]);

/**
 * "Kwetsbare stam": een kort woord dat veel voorkomt als de letterkern van
 * zwakke wachtwoorden (bv. "welkom" in "welkom123", "vve" in "vve2026").
 * De letters-kern (alle niet-letters verwijderd, gevergroot naar lowercase) van
 * het wachtwoord wordt hier tegengekeken. Dit vangt "woord + cijfers"
 * patronen zonder de kwetsbaarheid van een ruwe substring-match op de
 * hele string (dat zou valse-positives geven op goede wachtwoorden die een
 * kort woord bevatten).
 */
const KWETSBARE_STAMMEN = new Set<string>([
  'welkom',
  'welcome',
  'wachtwoord',
  'password',
  'admin',
  'administrator',
  'vve',
  'eigenaar',
  'woning',
  'appartement',
  'apartment',
  'secret',
  'test',
  'testing',
  'changeme',
  'changeit',
  'default',
  'master',
  'verw',
  'huis',
  'w0rd',
  'wo0rd',
]);

/** Een wachtwoord dat puur uit cijfers bestaat is triviaal te kraken. */
const ALLEEN_CIJFERS = /^\d+$/;

/**
 * Naam- of woord plus jaar (bv. "vve2026", "janssen1995", "familie-2026"):
 * een kort woord/numerator gevolgd door een jaar, eventueel met een scheiding.
 */
const NAAM_JAAR = /^[a-z0-9]{1,10}[-_ ]?(?:19|20)\d\d$/;

/**
 * Is het wachtwoord veelgebruikt of triviaal?
 *
 * Eén of meer van de volgende checks zijn genoeg om `true` te rapporteren:
 * 1. Exacte hit op de {@link ZWARTE_LIJST} (geënormaliseerd, gevergroot).
 * 2. Triviaal patroon via de {@link ALLEEN_CIJFERS} of {@link NAAM_JAAR} regexen.
 * 3. De "letters-kern" (alle niet-letters) komt in de {@link KWETSBARE_STAMMEN}
 *    set voor — vangt "woord + cijfers/anhang" zonder ruwe substring-match.
 */
function isVeelGebruikt(tekst: string): boolean {
  const norm = tekst.toLowerCase();
  if (ZWARTE_LIJST.has(norm)) return true;
  if (ALLEEN_CIJFERS.test(tekst)) return true;
  if (NAAM_JAAR.test(norm)) return true;
  // Letters-kern: alleen a-z behouden (niet-letters uit), en kijk of die
  // exact in de kwetsbare-stam-men set zit.
  const lettersKern = norm.replace(/[^a-z]/g, '');
  if (lettersKern.length > 0 && KWETSBARE_STAMMEN.has(lettersKern)) return true;
  return false;
}

/**
 * Beoordeelt de sterkte van een wachtwoord.
 *
 * `ok: true` alleen als het wachtwoord minimaal {@link MOINSTE_LENGTE} tekens
 * heeft én niet veelgebruikt/triviaal is. Er zijn per spec §7.6 **géén
 * verplichte complexiteitsregels** (geen "minstens één hoofdletter" of
 * dergelijke) — alleen lengte en bekendheid.
 *
 * @returns een {@link Beoordeling} met `ok` en een lijst met redenen.
 */
export function beoordeelWachtwoord(tekst: string): Beoordeling {
  const redenen: string[] = [];

  if (tekst.length < MOINSTE_LENGTE) {
    redenen.push(
       `Wachtwoord is te kort: minimaal ${String(MOINSTE_LENGTE)} tekens vereist (huidig: ${String(tekst.length)}).`,
     );
   }
  if (isVeelGebruikt(tekst)) {
    redenen.push(
      'Wachtwoord komt voor op een lijst met veelgebruikte/zwakke wachtwoorden of past in een triviaal patroon.',
    );
  }

  return { ok: redenen.length === 0, redenen };
}
