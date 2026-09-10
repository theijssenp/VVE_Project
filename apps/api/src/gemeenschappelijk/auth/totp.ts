/**
 * TOTP-terugval — F07 (spec §7.6: "TOTP als tweede terugval", §6.3-kolommen).
 *
 * Service rond otplib 13 (plugin-API: NobleCryptoPlugin + ScureBase32Plugin).
 * Het TOTP-secret staat versleuteld op `persoon.totp_secret_versleuteld`
 * (bytea); de echte versleuteling volgt in B01 (AES-256-GCM). Tot die tijd
 * is de encryptiefunctie een expliciet gemarkeerde HMAC-stream-XOR-plaats-
 * vervanger — platte-tekst secrets gaan nooit de database in, en de kolom-
 * structuur (bytea met versieprefix) klopt alvast.
 *
 * Herstelcodes: bij activatie N codes (default 10, 8 hex-tekens), éénmalig
 * getoond en als argon2-hashes opgeslagen in `persoon.herstelcodes_hash`
 * (text[]). Verbruikte codes worden uit de array verwijderd (§6.3).
 */

import { createHmac, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { persoon } from '../../database/schema/persoon.js';
import { hashWachtwoord, verifieerWachtwoord } from './wachtwoord.js';

/** Aantal herstelcodes bij activatie (spec: eenmalig getoond). */
export const HERSTELCODES_AANTAL = 10;
/** Lengte van een herstelcode: 4 bytes = 8 hex-tekens. */
const HERSTELCODE_BYTES = 4;
/** Versieprefix van de plaatsvervangerversleuteling (vervangen door B01). */
const PLAATSVERVANGER_VERSIE = 'v0:';
const PLAATSVERVANGER_SLEUTEL = 'VVE-TOTP-PLACEHOLDER-VERVANG-IN-B01';

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

function otplib(): Otplib {
  if (otplibGelezen === null) {
    // Otplib 13 is CJS met een dynamische plugin-API; een statische ESM-import
    // van de CJS-bundel resolved niet betrouwbaar onder NodeNext. De require
    // is hier bewust en centraal.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    otplibGelezen = require('otplib') as Otplib;
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
          totpSecretVersleuteld: versleutelPlaatsvervanger(secret, email),
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
      const secret = ontsleutelPlaatsvervanger(versleuteld, rij?.email ?? '');
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
      await db
        .update(persoon)
        .set({ herstelcodesHash: hashes })
        .where(eq(persoon.id, persoonId));
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
      await db
        .update(persoon)
        .set({ herstelcodesHash: over })
        .where(eq(persoon.id, persoonId));
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
// Versleutelings-placeholder (tot B01) — HMAC-sleutelstroom-XOR, gemarkeerd.
// ---------------------------------------------------------------------------

/**
 * Tijdelijke versleuteling vóór B01: XOR met een per-32-byte-blok hernieuwde
 * HMAC-sleutelstroom. Geen echte semantische security — het doel is alleen
 * dat er géén platte-tekst TOTP-secrets in de database staan en de kolom-
 * structuur (bytea met versieprefix "v0:") alvast klopt. Vervang in B01 door
 * AES-256-GCM met de omgevingssleutel (spec §6.2).
 */
export function versleutelPlaatsvervanger(tekst: string, context: string): Buffer {
  const bytes = Buffer.from(tekst, 'utf8');
  const uit = Buffer.alloc(bytes.length);
  const keystore = PLAATSVERVANGER_SLEUTEL + ':' + context;
  for (let i = 0; i < bytes.length; i += 1) {
    if (i % 32 === 0) {
      const blok = i / 32;
      const stroom = hmacStroom(keystore, blok);
      for (let j = 0; j < 32 && i + j < bytes.length; j += 1) {
        const sleutelByte = stroom[j] ?? 0;
        uit[i + j] = (bytes[i + j] ?? 0) ^ sleutelByte;
      }
    }
  }
  return Buffer.concat([Buffer.from(PLAATSVERVANGER_VERSIE, 'utf8'), uit]);
}

export function ontsleutelPlaatsvervanger(data: Buffer, context: string): string {
  const voorvoegsel = Buffer.from(PLAATSVERVANGER_VERSIE, 'utf8');
  const payload = data.subarray(voorvoegsel.length);
  const keystore = PLAATSVERVANGER_SLEUTEL + ':' + context;
  const uit = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    if (i % 32 === 0) {
      const blok = i / 32;
      const stroom = hmacStroom(keystore, blok);
      for (let j = 0; j < 32 && i + j < payload.length; j += 1) {
        const sleutelByte = stroom[j] ?? 0;
        uit[i + j] = (payload[i + j] ?? 0) ^ sleutelByte;
      }
    }
  }
  return uit.toString('utf8');
}

/** 32-byte sleutelstroom voor blok `n` (deterministisch, per keystore). */
function hmacStroom(keystore: string, n: number): Buffer {
  const vier = Math.floor(n);
  const teller = Uint8Array.of(
    (vier >>> 24) & 0xff,
    (vier >>> 16) & 0xff,
    (vier >>> 8) & 0xff,
    vier & 0xff,
  );
  return createHmac('sha256', keystore).update(teller).digest();
}