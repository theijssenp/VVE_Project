/** Injectietokens voor de clientschil — F11. */
import { InjectionToken } from '@angular/core';

import { CookieTokenOpslag, type TokenOpslag } from './token-opslag.js';

/** Basis-URL van de API; per omgeving in te stellen bij het opstarten. */
export const API_BASIS = new InjectionToken<string>('API_BASIS', {
  providedIn: 'root',
  factory: () => '/api',
});

/**
 * De opslagstrategie voor het refresh-token. Standaard de webvariant; de
 * native-build (blok N01) vervangt hem door de Secure-Storage-variant.
 */
export const TOKEN_OPSLAG = new InjectionToken<TokenOpslag>('TOKEN_OPSLAG', {
  providedIn: 'root',
  factory: () => new CookieTokenOpslag(),
});
