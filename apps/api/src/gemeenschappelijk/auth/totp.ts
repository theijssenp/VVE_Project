/**
 * TOTP-terugval — F07 (spec §7.6: "TOTP als tweede terugval", §6.3-kolommen).
 *
 * Service rond otplib 13 (plugin-API: NobleCryptoPlugin + ScureBase32Plugin).
 * Het TOTP-secret staat versleuteld op `persoon.totp_secret_versleuteld`
 * (bytea) met AES-256-GCM en een sleutel uit de omgeving (§6.2). B01 verhuist
 * deze functies naar een gedeelde module en gebruikt ze ook voor de IBAN-kolommen.
 * Tot die tijd
 * is de encryptiefunctie een expliciet gemarkeerde HMAC-stream-XOR-plaats-
 * vervanger — platte-tekst secrets gaan nooit de database in, en de kolom-
 * structuur (bytea met versieprefix) klopt alvast.
 *
 * Herstelcodes: bij activatie N codes (default 10, 8 hex-tekens), éénmalig
 * getoond en als argon2-hashes opgeslagen in `persoon.herstelcodes_hash`
 * (text[]). Verbruikte codes worden uit de array verwijderd (§6.3).
 */

import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { persoon } from '../../database/schema/persoon.js';
import { hashWachtwoord, verifieerWachtwoord } from './wachtwoord.js';

/** Aantal herstelcodes bij activatie (spec: eenmalig getoond). */
export const HERSTELCODES_AANTAL = 10;
/**
 * Lengte van een herstelcode: 16 bytes = 128 bits, als 32 hex-tekens.
 *
 * Een herstelcode omzeilt de tweede factor volledig — hij is een tweede wachtwoord,
 * geen bevestigingscode. Met 4 bytes (32 bits) en tien geldige codes per account is de
 * zoekruimte om er een te raden ongeveer 2^29; dat is met geautomatiseerd gokken
 * haalbaar zodra de verbruikfunctie niet zelf begrensd is.
 */
const HERSTELCODE_BYTES = 16;

/** Opslagformaat kolomversleuteling: `v1:` ‖ nonce(12) ‖ ciphertext ‖ tag(16). */
const KOLOM_VERSIE = 'v1:';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Foutklassen, zodat de controller ze kan onderscheiden (F08). */
export class TotpNietGeactiveerdFout extends Error {
  constructor() {
    super('TOTP is niet geactiveerd voor dit account');
    this.name = 'TotpNietGeactiveerdFout';
  }
}

export class OnGeldigeTotpCodeFout extends Error {
  constructor() {
    super('TOTP-code onjuist');
    this.name = 'OnGeldigeTotpCodeFout';
  }
}

export class OnjuisteHerstelcodeFout extends Error {
  constructor() {
    super('Herstelcode onjuist of al verbruikt');
    this.name = 'OnjuisteHerstelcodeFout';
  }
}

export interface TotpService {
  /** Genereert een nieuw TOTP-secret (base32), versleutelt het en activeert MFA. */
  activeer(persoonId: bigint, email: string): Promise<{ secret: string }>;
  /** Verifieert een 6-cijferige code tegen het versleutelde secret. */
  verifieer(persoonId: bigint, code: string): Promise<boolean>;
  /** Genereert herstelcodes; retourneert ze éénmalig in platte tekst. */
  genereerHerstelcodes(persoonId: bigint): Promise<string[]>;
  /** Verbruikt een herstelcode; verbruikte verdwijnen uit de array (§6.3). */
  verbruikHerstelcode(persoonId: bigint, code: string): Promise<boolean>;
}

/** otplib 13 typeveilig geprojecteerd op het deel dat we gebruiken. */
interface Otplib {
  readonly NobleCryptoPlugin: new () => unknown;
  readonly ScureBase32Plugin: new () => unknown;
  readonly generateSecret: (opts: { crypto: unknown; base32: unknown }) => string;
  readonly generate: (opts: Record<string, unknown>) => Promise<string>;
  readonly verify: (opts: Record<string, unknown>) => Promise<{ valid: boolean }>;
}

let otplibGelezen: Otplib | null = null;

/**
 * Otplib 13 is CJS met een dynamische plugin-API; een statische ESM-import van
 * de CJS-bundel resolved niet betrouwbaar onder NodeNext. Laden gebeurt daarom
 * op één plek, via `createRequire`.
 *
 * Dat laatste is niet cosmetisch. Hier stond een kale `require('otplib')`, en
 * `apps/api` is een ESM-pakket (`"type": "module"`): in het echte Node-proces
 * bestaat `require` daar niet en wierp elke TOTP-handeling een
 * `ReferenceError`, die als 500 naar buiten kwam. De tests zagen dat niet — de
 * testrunner biedt wél een CJS-interop — en de servicetests waren de enige die
 * deze code raakten. Pas het draaien van de echte server bracht het aan het
 * licht. `createRequire(import.meta.url)` is de ESM-manier om een CJS-module te
 * laden en werkt in beide omgevingen.
 */
function otplib(): Otplib {
  if (otplibGelezen === null) {
    otplibGelezen = createRequire(import.meta.url)('otplib') as Otplib;
  }
  return otplibGelezen;
}

export function maakTotpService(config: { readonly db: NodePgDatabase }): TotpService {
  const { db } = config;

  return {
    async activeer(persoonId, email) {
      const secret = genereerTotpSecret();
      await db
        .update(persoon)
        .set({
          totpSecretVersleuteld: versleutelKolom(secret, email),
          mfaVerplicht: true,
        })
        .where(eq(persoon.id, persoonId));
      return { secret };
    },

    async verifieer(persoonId, code) {
      const [rij] = await db
        .select({ secret: persoon.totpSecretVersleuteld, email: persoon.email })
        .from(persoon)
        .where(eq(persoon.id, persoonId))
        .limit(1);
      const versleuteld = rij?.secret ?? null;
      if (versleuteld === null) {
        throw new TotpNietGeactiveerdFout();
      }
      const secret = ontsleutelKolom(versleuteld, rij?.email ?? '');
      const geldig = await verifieerTotpCode(secret, code);
      if (!geldig) {
        throw new OnGeldigeTotpCodeFout();
      }
      return true;
    },

    async genereerHerstelcodes(persoonId) {
      const codes = Array.from({ length: HERSTELCODES_AANTAL }, () =>
        randomBytes(HERSTELCODE_BYTES).toString('hex'),
      );
      const hashes = [];
      for (const code of codes) {
        hashes.push(await hashWachtwoord(code));
      }
      await db.update(persoon).set({ herstelcodesHash: hashes }).where(eq(persoon.id, persoonId));
      // De codes gaan éénmalig terug naar de beller (§7.6); hierna is alleen
      // de hash in de database bekend.
      return codes;
    },

    async verbruikHerstelcode(persoonId, code) {
      const [rij] = await db
        .select({ hashes: persoon.herstelcodesHash })
        .from(persoon)
        .where(eq(persoon.id, persoonId))
        .limit(1);
      const hashes = rij?.hashes ?? [];
      let getroffen = -1;
      let geldig = false;
      for (let i = 0; i < hashes.length; i += 1) {
        const hash = hashes[i];
        if (hash !== undefined && (await verifieerWachtwoord(code, hash))) {
          geldig = true;
          getroffen = i;
          break;
        }
      }
      if (!geldig || getroffen < 0) {
        throw new OnjuisteHerstelcodeFout();
      }
      const over = hashes.filter((_, i) => i !== getroffen);
      await db.update(persoon).set({ herstelcodesHash: over }).where(eq(persoon.id, persoonId));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// TOTP-primitives (otplib 13 vereist plugins; één instelling, hier gebundeld).
// ---------------------------------------------------------------------------

/** Genereert een base32-secret met de otplib-plugins (RFC-advies: 20 bytes). */
export function genereerTotpSecret(): string {
  const lib = otplib();
  const cryptoPlugin = new lib.NobleCryptoPlugin();
  const base32Plugin = new lib.ScureBase32Plugin();
  return lib.generateSecret({ crypto: cryptoPlugin, base32: base32Plugin });
}

/** Verifieert een 6-cijferige TOTP-code met de standaard ±1 stapstolerantie. */
export async function verifieerTotpCode(secret: string, code: string): Promise<boolean> {
  const lib = otplib();
  const opts = {
    digits: 6,
    period: 30,
    crypto: new lib.NobleCryptoPlugin(),
    base32: new lib.ScureBase32Plugin(),
  };
  const uitkomst = await lib.verify({ token: code, secret, ...opts });
  return uitkomst.valid;
}

/** Genereert de actuele 6-cijferige code voor een secret (testhulp en hotp-vergelijk). */
export async function genereerTotpCodeVoor(secret: string): Promise<string> {
  const lib = otplib();
  const opts = {
    digits: 6,
    period: 30,
    crypto: new lib.NobleCryptoPlugin(),
    base32: new lib.ScureBase32Plugin(),
  };
  return lib.generate({ secret, ...opts });
}

// ---------------------------------------------------------------------------
// Kolomversleuteling (spec §6.2): AES-256-GCM met een sleutel uit de omgeving.
// ---------------------------------------------------------------------------

/**
 * Afgeleide 32-byte sleutel uit `KOLOM_SLEUTEL`. Eén keer berekend en bewaard:
 * scrypt is bewust traag en hoeft niet per aanroep te draaien.
 *
 * Er is geen terugvalwaarde. Een sleutel in de broncode zou betekenen dat een
 * databasedump plus de repository alle TOTP-secrets prijsgeeft — en daarmee de
 * tweede factor van elke gebruiker, want met het secret genereer je zelf geldige
 * codes. Ontbreekt de sleutel, dan start de dienst niet.
 */
let sleutelCache: Buffer | null = null;
function kolomSleutel(): Buffer {
  const bestaand = sleutelCache;
  if (bestaand !== null) return bestaand;
  const ruw = process.env['KOLOM_SLEUTEL'];
  if (ruw === undefined || ruw === '') {
    throw new Error(
      'KOLOM_SLEUTEL ontbreekt. Zet een willekeurige waarde van minimaal 32 tekens in de ' +
        'omgeving (zie .env.voorbeeld); er is bewust geen standaardwaarde.',
    );
  }
  if (ruw.length < 32) {
    throw new Error(`KOLOM_SLEUTEL moet minimaal 32 tekens zijn (nu ${String(ruw.length)}).`);
  }
  const afgeleid = scryptSync(ruw, 'vve-kolomsleutel-v1', 32);
  sleutelCache = afgeleid;
  return afgeleid;
}

/**
 * Versleutelt met AES-256-GCM. Opslagformaat: `v1:` ‖ nonce(12) ‖ ciphertext ‖ tag(16),
 * conform §6.2. De `context` (hier het e-mailadres) gaat als AAD mee, zodat een
 * ciphertext niet naar een andere rij te verplaatsen is.
 *
 * De nonce komt per aanroep uit de CSPRNG. Nonce-hergebruik breekt GCM volledig —
 * niet alleen de vertrouwelijkheid maar ook de authenticatie — dus die mag nooit
 * een vaste waarde worden.
 */
export function versleutelKolom(tekst: string, context: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kolomSleutel(), nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(tekst, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from(KOLOM_VERSIE, 'utf8'), nonce, ct, cipher.getAuthTag()]);
}

/** Ontsleutelt het formaat uit {@link versleutelKolom}; werpt bij een gewijzigde tag. */
export function ontsleutelKolom(data: Buffer, context: string): string {
  const voorvoegsel = Buffer.from(KOLOM_VERSIE, 'utf8');
  if (!data.subarray(0, voorvoegsel.length).equals(voorvoegsel)) {
    throw new Error('Onbekend versleutelformaat in kolom (verwacht v1:).');
  }
  const romp = data.subarray(voorvoegsel.length);
  const nonce = romp.subarray(0, NONCE_BYTES);
  const tag = romp.subarray(romp.length - TAG_BYTES);
  const ct = romp.subarray(NONCE_BYTES, romp.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kolomSleutel(), nonce);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
