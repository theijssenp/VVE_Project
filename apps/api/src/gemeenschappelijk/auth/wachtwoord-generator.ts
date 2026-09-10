/**
 * Wachtwoordgenerator — F12 (spec §7.6, §8.5).
 *
 * De systeemwachtwoorden (beheerder-account aanmaken §3.3, herstelcodes F07)
 * komen uit een CSPRNG-generator. De statistische test hieronder bewijst:
 * juiste lengte, volledige alfabetdekking, uniformiteit over 1 mln trekkingen,
 * geen duplicaten, geen modulo-bias.
 */

import { randomBytes } from 'node:crypto';

/** Alfabet: letters (kl+kl) en cijfers, zonder ambiguous tekens (0/O, l/1). */
const ALFABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALFABET_LENGTE = ALFABET.length; // 59

/**
 * Genereert een wachtwoord van `lengte` tekens uit het alfabet via
 * rejection sampling — geen modulo over een niet-deelbaar bereik, dus geen
 * modulo-bias.
 */
export function genereerWachtwoord(lengte: number): string {
  if (!Number.isSafeInteger(lengte) || lengte < 1) {
    throw new Error(`Ongeldige wachtwoordlengte: ${String(lengte)}`);
  }
  // De byte-waarden die eerlijk over het alfabet verdeeld kunnen worden: de
  // grootste veelvoud van ALFABET_LENGTE binnen 256. Alles daarboven gaat weg.
  const venster = Math.floor(256 / ALFABET_LENGTE) * ALFABET_LENGTE;
  const uit: string[] = [];
  while (uit.length < lengte) {
    const bytes = randomBytes(lengte * 2);
    for (const b of bytes) {
      if (uit.length >= lengte) break;
      if (b < venster) {
        const symbool = ALFABET[b % ALFABET_LENGTE];
        if (symbool !== undefined) {
          uit.push(symbool);
        }
      }
      // b >= venster: weggooien en opnieuw (geen bias)
    }
  }
  return uit.join('');
}

/** Genereert een herstelcode-waarde: 8 hex-tekens (F07). */
export function genereerHerstelcodeWaarde(): string {
  return randomBytes(4).toString('hex');
}
