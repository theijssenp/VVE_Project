/**
 * Rechten-declaratie — F08 (spec §7.5, test #32).
 *
 * Elke controller-actie declareert expliciet welk recht vereist is
 * (`@VereistRecht('nota.genereren')`). Ontbreekt de declaratie, dan weigert de
 * router: de opstarttest (test #32) inventariseert alle routes en faalt als er
 * één zonder decorator is. Deny by default.
 */

import { SetMetadata } from '@nestjs/common';

/** Metadata-sleutel voor de `@VereistRecht`-decorator. */
export const VEREIST_RECHT_SLEUTEL = 'vve:vereist_recht';

/**
 * Interface van de decorator: een handgeschreven decorator-signature zou in
 * Nest 11 reflect-metadata-vorm een `CustomDecorator` zijn; hier expliciet.
 */
export interface VereistRechtMetadata {
  readonly recht: string;
}

/**
 * Declareert het recht dat een route vereist. De TenantGuard/RolGuard leest
 * deze metadata via `Reflector` (spec §7.5 stap 1–3).
 */
export function VereistRecht(recht: string): MethodDecorator & ClassDecorator {
  return SetMetadata(VEREIST_RECHT_SLEUTEL, { recht } satisfies VereistRechtMetadata);
}

/** Leest de rechtdeclaraties van een handler (of klassen-niveau als fallback). */
export function leesVereistRecht(lezer: (sleutel: string) => unknown): VereistRechtMetadata | null {
  const waarde = lezer(VEREIST_RECHT_SLEUTEL);
  if (
    waarde !== null &&
    typeof waarde === 'object' &&
    'recht' in waarde &&
    typeof (waarde as VereistRechtMetadata).recht === 'string'
  ) {
    return waarde as VereistRechtMetadata;
  }
  return null;
}
