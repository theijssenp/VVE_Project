/**
 * MFA-gate — F07 (spec §7.6 "MFA verplicht op basis van rechten", §8.5).
 *
 * De regel: een recht uit de geldstroomlijst mag alleen worden toegekend aan
 * iemand die een tweede factor heeft (passkey of TOTP). Zo kan een later
 * toegevoegde rol nooit per ongeluk zonder MFA bij het geld. Herauthenticatie
 * (opnieuw MFA op de handeling, ongeacht de lopende sessie) volgt op F08.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { persoon } from '../../database/schema/persoon.js';
import { passkey } from '../../database/schema/passkey.js';
import { GELDSTROOM_RECHTEN } from './passkey.js';

/** Recht uit de geldstroomlijst (§8.5-handelingen). */
export type GeldstroomRecht = (typeof GELDSTROOM_RECHTEN)[number];

export class MfaVereistFout extends Error {
  constructor(readonly recht: GeldstroomRecht) {
    super(
      `Recht "${recht}" behoort tot de geldstroom en vereist een tweede factor; ` +
        'het account heeft geen actieve MFA (passkey of TOTP).',
    );
    this.name = 'MfaVereistFout';
  }
}

export class OnbekendRechtFout extends Error {
  constructor(recht: string) {
    super(`Onbekend recht: ${recht}`);
    this.name = 'OnbekendRechtFout';
  }
}

export interface MfaGate {
  /** Is het recht een geldstroomrecht? */
  isGeldstroomRecht(recht: string): recht is GeldstroomRecht;
  /**
   * Controleert of de persoon het geldstroomrecht mag dragen: er moet een
   * actieve tweede factor zijn (passkey-rij óf geactiveerd TOTP). Werpt
   * `MfaVereistFout` als dat niet zo is.
   */
  vereisMfaVoor(persoonId: bigint, recht: string): Promise<void>;
  /** Heeft de persoon actieve MFA? (voor UI-signaal, geen gate). */
  heeftMfa(persoonId: bigint): Promise<boolean>;
}

export function maakMfaGate(config: { readonly db: NodePgDatabase }): MfaGate {
  const { db } = config;
  const geldstroomSet = new Set<string>(GELDSTROOM_RECHTEN);

  return {
    isGeldstroomRecht(recht: string): recht is GeldstroomRecht {
      return geldstroomSet.has(recht);
    },

    async vereisMfaVoor(persoonId, recht) {
      if (!geldstroomSet.has(recht)) {
        // Niet-geldstroomrechten zijn hier niet aan de orde; onbekende
        // rechten weigert de RolGuard (F08). De gate is alleen bewaker op
        // de geldstroomlijst.
        return;
      }
      const geldRecht = recht as GeldstroomRecht;
      const [rij] = await db
        .select({
          totp: persoon.totpSecretVersleuteld,
        })
        .from(persoon)
        .where(eq(persoon.id, persoonId))
        .limit(1);
      if (rij === undefined) {
        throw new MfaVereistFout(geldRecht);
      }
      const heeftTotp = rij.totp !== null;
      const passkeys = await db
        .select({ id: passkey.id })
        .from(passkey)
        .where(eq(passkey.persoonId, persoonId))
        .limit(1);
      const heeftPasskey = passkeys.length > 0;
      if (!heeftTotp && !heeftPasskey) {
        throw new MfaVereistFout(geldRecht);
      }
    },

    async heeftMfa(persoonId) {
      const [rij] = await db
        .select({ totp: persoon.totpSecretVersleuteld })
        .from(persoon)
        .where(eq(persoon.id, persoonId))
        .limit(1);
      const heeftTotp = (rij?.totp ?? null) !== null;
      if (heeftTotp) return true;
      const passkeys = await db
        .select({ id: passkey.id })
        .from(passkey)
        .where(eq(passkey.persoonId, persoonId))
        .limit(1);
      return passkeys.length > 0;
    },
  };
}
