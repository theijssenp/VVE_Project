/**
 * Tokenopslag — F11 (spec §7.6, §7.8).
 *
 * Het access-token leeft **uitsluitend in het geheugen** en wordt nergens
 * bewaard: het is vijftien minuten geldig en na een herlaadactie haalt de
 * client gewoon een nieuw exemplaar op met het refresh-token.
 *
 * Voor het refresh-token verschilt het pad per platform, en dat verschil is de
 * hele reden dat deze abstractie bestaat:
 *
 * - **web**: het refresh-token staat in een httpOnly-cookie die de server zet.
 *   De client ziet hem dus nooit en kan hem ook niet lekken via XSS. Daarom
 *   bewaart de webimplementatie hieronder niets — verversen gebeurt door het
 *   endpoint aan te roepen met `credentials: 'include'`.
 * - **native**: daar bestaan geen httpOnly-cookies, dus komt het opake token in
 *   Keychain respectievelijk Android Keystore via Capacitor Secure Storage.
 *
 * `localStorage`, `sessionStorage` en `Preferences` komen hier niet voor, en dat
 * is geen toeval: alles wat JavaScript kan lezen, kan een XSS-fout ook lezen.
 */

export type ClientSoort = 'web' | 'native';

export interface TokenOpslag {
  readonly soort: ClientSoort;
  /** Bewaart het refresh-token, voor zover dit platform dat zelf moet doen. */
  bewaarRefresh(token: string): Promise<void>;
  /** Leest het refresh-token; `null` wanneer het platform het niet zelf bewaart. */
  leesRefresh(): Promise<string | null>;
  /** Wist wat er bewaard is (uitloggen). */
  wis(): Promise<void>;
}

/**
 * Webvariant: bewaart bewust niets. De server zet het refresh-token als
 * httpOnly-cookie; de client heeft er geen kopie van nodig en mag die ook niet
 * hebben.
 */
export class CookieTokenOpslag implements TokenOpslag {
  readonly soort: ClientSoort = 'web';

  bewaarRefresh(): Promise<void> {
    // Niets te doen: de cookie is al gezet door het antwoord van de server.
    return Promise.resolve();
  }

  leesRefresh(): Promise<string | null> {
    // Onleesbaar voor JavaScript — dat is de bedoeling.
    return Promise.resolve(null);
  }

  wis(): Promise<void> {
    // De server wist de cookie bij het uitlog-endpoint.
    return Promise.resolve();
  }
}

/**
 * Nativevariant. De daadwerkelijke koppeling met Capacitor Secure Storage komt
 * in blok N01/N04; tot die tijd werpt deze klasse in plaats van stilletjes naar
 * een onveilige opslag terug te vallen.
 */
export class VeiligeOpslagTokenOpslag implements TokenOpslag {
  readonly soort: ClientSoort = 'native';

  bewaarRefresh(): Promise<void> {
    return Promise.reject(new Error(NATIVE_NOG_NIET));
  }

  leesRefresh(): Promise<string | null> {
    return Promise.reject(new Error(NATIVE_NOG_NIET));
  }

  wis(): Promise<void> {
    return Promise.reject(new Error(NATIVE_NOG_NIET));
  }
}

const NATIVE_NOG_NIET =
  'Native tokenopslag is nog niet gekoppeld (blok N01/N04). Val hier niet terug ' +
  'op localStorage: dat is leesbaar voor elke XSS-fout.';

/** Het access-token, uitsluitend in het geheugen van deze tab. */
export class GeheugenAccessToken {
  #token: string | null = null;

  zet(token: string | null): void {
    this.#token = token;
  }

  lees(): string | null {
    return this.#token;
  }

  get aanwezig(): boolean {
    return this.#token !== null;
  }
}
