/**
 * IBAN-versleuteling — blok B01 (spec §6.2).
 *
 * Het §6.2-drieluik als één module, zodat er nergens anders in de codebase
 * een beslissing over crypto valt:
 *
 *   - `versleutelIban` — AES-256-GCM, sleutel uit de omgeving. Coderblok =
 *     nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes), precies de spec-vorm.
 *     Een vaste IV bij GCM is de ernstigste fout die je kunt maken (hergebruik
 *     van nonce breekt de authenticiteit volledig); F12 heeft er een
 *     ESLint-wachter tegen.
 *   - `ibanHmac` — HMAC-SHA256 over het **genormaliseerde** IBAN met een
 *     aparte, vaste zoeksleutel. Deterministisch, dus indexeerbaar: de
 *     matchingmotor (B05) koppelt een bankmutatie aan een eigenaar zonder
 *     ooit te ontsleutelen. Aparte sleutel, want de versleutel- en de
 *     zoeksleutel hebben verschillende levenscycli.
 *   - `ibanMasker` — `NL91 **** **** 1234`, voor lijsten.
 *   - `sleutelVersie` — maakt rotatie zonder downtime mogelijk.
 *
 * IBAN-normalisatie: spaties en streepjes eruit, hoofdletters. Zonder
 * normalisatie matchen `NL91 ABNA 0417 1643 00` en `nl91abna41716430` niet
 * op dezelfde HMAC — en dan is de zoeksleutel waardeloos.
 *
 * Geen standaardsleutels (§8.2): ontbreekt een omgevingsvariabele, dan
 * start de module niet.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const NONCE_LENGTE = 12;
const TAG_LENGTE = 16;
/** Eén sleutelversie; rotatie voegt er later meer toe. */
export const HUIDIGE_SLEUTEL_VERSIE = 1;

export class SleutelOntbreektFout extends Error {
  constructor(naam: string) {
    super(`Omgevingsvariabele ${naam} ontbreekt; IBAN-versleuteling start niet (§8.2).`);
    this.name = 'SleutelOntbreektFout';
  }
}

export class OnjuisteSleutelFout extends Error {
  constructor() {
    super('Ontsleuteling mislukt: verkeerde sleutel of corrupte ciphertext.');
    this.name = 'OnjuisteSleutelFout';
  }
}

export class OngeldigIbanFout extends Error {
  constructor() {
    super('Dit is geen geldig IBAN.');
    this.name = 'OngeldigIbanFout';
  }
}

/** Leest een hex- of base64-geheim uit de omgeving; geen standaardwaarde (§8.2). */
function omgevingsSleutel(naam: string, bytes: number, env: NodeJS.ProcessEnv): Buffer {
  const waarde = env[naam];
  if (waarde === undefined || waarde === '') {
    throw new SleutelOntbreektFout(naam);
  }
  const hex = /^[0-9a-fA-F]+$/.test(waarde);
  if (hex && waarde.length >= bytes * 2) {
    return Buffer.from(waarde, 'hex');
  }
  // Base64- of willekeurige tekenreeks: als het minstens `bytes` tekens is,
  // nemen we de bytes van de tekst zelf (deterministisch, goed gedefinieerd).
  const buffer = Buffer.from(waarde, 'utf8');
  if (buffer.length < bytes) {
    throw new Error(
      `${naam} moet minimaal ${String(bytes)} bytes zijn (nu ${String(buffer.length)}).`,
    );
  }
  return buffer.subarray(0, bytes);
}

export interface IbanSleutels {
  readonly versleutelSleutel: Buffer;
  readonly hmacSleutel: Buffer;
}

/** Bouwt de sleutels uit de opgegeven omgeving; faalt hard als ze ontbreken (§8.2). */
export function laadIbanSleutels(env: NodeJS.ProcessEnv = process.env): IbanSleutels {
  return {
    versleutelSleutel: omgevingsSleutel('IBAN_VERSLEUTEL_SLEUTEL', 32, env),
    hmacSleutel: omgevingsSleutel('IBAN_HMAC_SLEUTEL', 32, env),
  };
}

/**
 * Normaliseert een IBAN: spaties/streepjes eruit, hoofdletters. Zo matcht
 * dezelfde rekening met of zonder groeperingstekens op dezelfde HMAC.
 */
export function normaliseerIban(iban: string): string {
  return iban.replace(/[\s-]/g, '').toUpperCase();
}

/** IBAN-modulo-97 toets (spec §10-pre-vereiste): valide formaat + checksum. */
export function isGeldigIban(iban: string): boolean {
  const genormaliseerd = normaliseerIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(genormaliseerd)) return false;
  // Letters → getallen (A=10 … Z=35), BBAN naar voren, controlegetallen naar
  // het einde — de standaardmod-97-herordering.
  const herordend = `${genormaliseerd.slice(4)}${genormaliseerd.slice(0, 4)}`;
  const numeriek = herordend.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  // BigInt-modulo: de herordende reeks is te lang voor Number-veiligheid.
  let rest = 0n;
  for (const teken of numeriek) {
    rest = (rest * 10n + BigInt(teken)) % 97n;
  }
  return rest === 1n;
}

/** `NL91 **** **** 1234` — alleen voor weergave (§6.2). */
export function ibanMasker(iban: string): string {
  const genormaliseerd = normaliseerIban(iban);
  const laatsteVier = genormaliseerd.slice(-4);
  return `${genormaliseerd.slice(0, 4)} **** **** ${laatsteVier}`;
}

/** AES-256-GCM: nonce ‖ ciphertext ‖ tag in één bytea (§6.2). */
export function versleutelIban(iban: string, sleutels: IbanSleutels): Buffer {
  if (!isGeldigIban(iban)) {
    throw new OngeldigIbanFout();
  }
  const genormaliseerd = normaliseerIban(iban);
  const nonce = randomBytes(NONCE_LENGTE);
  const cipher = createCipheriv('aes-256-gcm', sleutels.versleutelSleutel, nonce);
  const ciphertext = Buffer.concat([cipher.update(genormaliseerd, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/** Keert `versleutelIban` om; een verkeerde sleutel of corrupte ciphertext → fout. */
export function ontsleutelIban(versleuteld: Buffer, sleutels: IbanSleutels): string {
  if (versleuteld.length < NONCE_LENGTE + TAG_LENGTE + 1) {
    throw new OnjuisteSleutelFout();
  }
  const nonce = versleuteld.subarray(0, NONCE_LENGTE);
  const tag = versleuteld.subarray(versleuteld.length - TAG_LENGTE);
  const ciphertext = versleuteld.subarray(NONCE_LENGTE, versleuteld.length - TAG_LENGTE);
  try {
    const decipher = createDecipheriv('aes-256-gcm', sleutels.versleutelSleutel, nonce);
    decipher.setAuthTag(tag);
    const platteTekst = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return platteTekst.toString('utf8');
  } catch {
    throw new OnjuisteSleutelFout();
  }
}

/** HMAC-SHA256 over het genormaliseerde IBAN; deterministisch en indexeerbaar (§6.2). */
export function ibanHmac(iban: string, sleutels: IbanSleutels): Buffer {
  return createHmac('sha256', sleutels.hmacSleutel).update(normaliseerIban(iban), 'utf8').digest();
}

/** Het volledige drieluik in één handeling: wat de service-laag aanroept. */
export function beveiligIban(
  iban: string,
  sleutels: IbanSleutels,
): {
  readonly versleuteld: Buffer;
  readonly hmac: Buffer;
  readonly masker: string;
  readonly sleutelVersie: number;
} {
  if (!isGeldigIban(iban)) {
    throw new OngeldigIbanFout();
  }
  return {
    versleuteld: versleutelIban(iban, sleutels),
    hmac: ibanHmac(iban, sleutels),
    masker: ibanMasker(iban),
    sleutelVersie: HUIDIGE_SLEUTEL_VERSIE,
  };
}
