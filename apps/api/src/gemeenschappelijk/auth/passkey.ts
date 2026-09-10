/**
 * Passkey-service (WebAuthn) — F07 (spec §7.6, §6.3 `passkey`).
 *
 * WebAuthn via @simplewebauthn/server v14. Passkeys zijn de primaire
 * inlogmethode (§7.6); de registratie verloopt via de PWA (native plugin
 * volgt in fase 7). De service beheert de challenges (in-memory, korte
 * levensduur), registratie- en authenticatieverificatie en de credential-
 * opslag. De controller (F08) hangt de challenges aan de HTTP-sessie.
 *
 * MFA-verplichting op geldstroomrechten (§7.6, §8.5) zit in de MFA-gate
 * (`mfa-gate.ts`), niet hier.
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { passkey } from '../../database/schema/passkey.js';
import { persoon } from '../../database/schema/persoon.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const swa = require('@simplewebauthn/server') as typeof import('@simplewebauthn/server');

/** Relying Party — in productie de domeinnaam; via config. */
export interface PasskeyServiceConfig {
  readonly db: NodePgDatabase;
  readonly rpId: string;
  readonly rpNaam: string;
  /** Herkomst-URL waarvan registratie/authenticatie moet komen (§7.5-geest). */
  readonly origin: string;
}

export class PasskeyNietGevondenFout extends Error {
  constructor() {
    super('Passkey niet gevonden voor dit account');
    this.name = 'PasskeyNietGevondenFout';
  }
}

export class PasskeyVerificatieFout extends Error {
  constructor(onderliggende: string) {
    super(`Passkey-verificatie mislukt: ${onderliggende}`);
    this.name = 'PasskeyVerificatieFout';
  }
}

/**
 * Geldstroomrechten (§8.5-handelingen). Een recht uit deze lijst mag niet
 * worden toegekend aan iemand zonder tweede factor (§7.6). De gate zelf is
 * `mfa-gate.ts`.
 */
export const GELDSTROOM_RECHTEN = [
  'incasso.batch.genereer',
  'incasso.batch.goedkeuren',
  'vve.iban.wijzig',
  'vve.incassant_id.wijzig',
  'mandaat.muteer',
  'boekjaar.afsluiten',
  'gebruiker.rol.wijzig',
] as const;

/** In-memory challenge-store (TTL 5 min). De controller mag hem overnemen. */
const CHALLENGES = new Map<string, { waarde: string; verloopt: number }>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function bewaarChallenge(sleutel: string, waarde: string): void {
  CHALLENGES.set(sleutel, { waarde, verloopt: Date.now() + CHALLENGE_TTL_MS });
}

function leesChallenge(sleutel: string): string | null {
  const rij = CHALLENGES.get(sleutel);
  if (rij === undefined) return null;
  if (Date.now() > rij.verloopt) {
    CHALLENGES.delete(sleutel);
    return null;
  }
  return rij.waarde;
}

export interface PasskeyRij {
  readonly id: bigint;
  readonly apparaatNaam: string | null;
  readonly laatstGebruiktOp: Date | null;
}

export function maakPasskeyService(config: PasskeyServiceConfig): {
  registratieOpties: (persoonId: bigint, email: string) => Promise<Record<string, unknown>>;
  verifieerRegistratie: (
    persoonId: bigint,
    apparaatNaam: string,
    antwoord: Record<string, unknown>,
  ) => Promise<{ geregistreerd: boolean; credentialId: string }>;
  authenticatieOpties: (email?: string) => Promise<Record<string, unknown>>;
  verifieerAuthenticatie: (
    email: string,
    antwoord: Record<string, unknown>,
  ) => Promise<{ persoonId: bigint }>;
  /** Lijst van passkeys van een persoon (profiel-scherm, §7.6). */
  lijst: (persoonId: bigint) => Promise<PasskeyRij[]>;
  /** Verwijdert een passkey (verlies van apparaat). */
  verwijder: (persoonId: bigint, passkeyId: bigint) => Promise<boolean>;
} {
  const { db, rpId, rpNaam, origin } = config;

  return {
    async registratieOpties(persoonId, email) {
      const bestaande = await db
        .select({ credentialId: passkey.credentialId })
        .from(passkey)
        .where(eq(passkey.persoonId, persoonId));
      const opties = await swa.generateRegistrationOptions({
        rpName: rpNaam,
        rpID: rpId,
        userID: new TextEncoder().encode(`vve:${String(persoonId)}`),
        userName: email,
        excludeCredentials: bestaande.map((r) => ({
          id: Buffer.from(r.credentialId).toString('base64url'),
        })),
      });
      bewaarChallenge(`reg:${String(persoonId)}`, opties.challenge);
      return opties as unknown as Record<string, unknown>;
    },

    async verifieerRegistratie(persoonId, apparaatNaam, antwoord) {
      const verwachteChallenge = leesChallenge(`reg:${String(persoonId)}`);
      if (verwachteChallenge === null) {
        throw new PasskeyVerificatieFout('registratie-challenge verlopen of onbekend');
      }
      const verificatie = await swa.verifyRegistrationResponse({
        response: antwoord as unknown as Parameters<
          typeof swa.verifyRegistrationResponse
        >[0]['response'],
        expectedChallenge: verwachteChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: true,
      });
      if (!verificatie.verified) {
        throw new PasskeyVerificatieFout('registratie geweigerd');
      }
      const { credential } = verificatie.registrationInfo;
      const credentialIdBytes = Buffer.from(credential.id, 'base64url');
      const publiekeSleutelBytes = Buffer.from(credential.publicKey);
      await db.insert(passkey).values({
        persoonId,
        credentialId: credentialIdBytes,
        publiekeSleutel: publiekeSleutelBytes,
        teller: BigInt(credential.counter),
        apparaatNaam,
      });
      return { geregistreerd: true, credentialId: credential.id };
    },

    async authenticatieOpties(email) {
      let toegestane: { id: string }[] = [];
      if (email !== undefined) {
        const [persoonRij] = await db
          .select({ id: persoon.id })
          .from(persoon)
          .where(eq(persoon.email, email))
          .limit(1);
        if (persoonRij) {
          const credentials = await db
            .select({ credentialId: passkey.credentialId })
            .from(passkey)
            .where(eq(passkey.persoonId, persoonRij.id));
          toegestane = credentials.map((c) => ({
            id: Buffer.from(c.credentialId).toString('base64url'),
          }));
        }
      }
      const opties = await swa.generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials: toegestane,
        userVerification: 'preferred',
      });
      bewaarChallenge(`auth:${email ?? '*'}`, opties.challenge);
      return opties as unknown as Record<string, unknown>;
    },

    async verifieerAuthenticatie(email, antwoord) {
      const [persoonRij] = await db
        .select({ id: persoon.id })
        .from(persoon)
        .where(eq(persoon.email, email))
        .limit(1);
      if (persoonRij === undefined) {
        throw new PasskeyNietGevondenFout();
      }
      const antwoordCred = (antwoord as { id?: string }).id;
      if (typeof antwoordCred !== 'string') {
        throw new PasskeyVerificatieFout('ontbrekend credential-id');
      }
      const [passkeyRij] = await db
        .select()
        .from(passkey)
        .where(
          and(
            eq(passkey.persoonId, persoonRij.id),
            eq(passkey.credentialId, Buffer.from(antwoordCred, 'base64url')),
          ),
        )
        .limit(1);
      if (passkeyRij === undefined) {
        throw new PasskeyNietGevondenFout();
      }
      const verwachteChallenge = leesChallenge(`auth:${email}`);
      if (verwachteChallenge === null) {
        throw new PasskeyVerificatieFout('authenticatie-challenge verlopen of onbekend');
      }
      const verificatie = await swa.verifyAuthenticationResponse({
        response: antwoord as unknown as Parameters<
          typeof swa.verifyAuthenticationResponse
        >[0]['response'],
        expectedChallenge: verwachteChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: antwoordCred,
          publicKey: new Uint8Array(passkeyRij.publiekeSleutel),
          counter: Number(passkeyRij.teller),
        },
        requireUserVerification: false,
      });
      if (!verificatie.verified) {
        throw new PasskeyVerificatieFout('authenticatie-assertie ongeldig');
      }
      await db
        .update(passkey)
        .set({
          teller: BigInt(verificatie.authenticationInfo.newCounter),
          laatstGebruiktOp: new Date(),
        })
        .where(eq(passkey.id, passkeyRij.id));
      return { persoonId: persoonRij.id };
    },

    async lijst(persoonId) {
      return db
        .select({
          id: passkey.id,
          apparaatNaam: passkey.apparaatNaam,
          laatstGebruiktOp: passkey.laatstGebruiktOp,
        })
        .from(passkey)
        .where(eq(passkey.persoonId, persoonId));
    },

    async verwijder(persoonId, passkeyId) {
      const resultaat = await db
        .delete(passkey)
        .where(and(eq(passkey.persoonId, persoonId), eq(passkey.id, passkeyId)))
        .returning();
      return resultaat.length > 0;
    },
  };
}
