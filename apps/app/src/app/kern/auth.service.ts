/**
 * Authenticatiedienst — F11 (spec §7.6).
 *
 * Houdt het access-token in het geheugen, praat met de auth-endpoints en biedt
 * de schermen een signaal met de huidige toestand. De dienst kiest zelf géén
 * opslagstrategie: die komt via {@link TokenOpslag} binnen, zodat web en native
 * hetzelfde pad volgen met een ander slot eronder.
 */

import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASIS, TOKEN_OPSLAG } from './tokens.js';
import { GeheugenAccessToken } from './token-opslag.js';

export interface InlogAntwoord {
  readonly accessToken: string;
  readonly mfaVereist?: boolean;
}

export interface Apparaat {
  readonly sessieId: string;
  readonly platform: string | null;
  readonly apparaatNaam: string | null;
  readonly laatsteGebruiktOp: string | null;
  readonly actief: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #http = inject(HttpClient);
  readonly #basis = inject(API_BASIS);
  readonly #opslag = inject(TOKEN_OPSLAG);
  readonly #access = new GeheugenAccessToken();

  /** `true` zodra er een bruikbaar access-token is. */
  readonly ingelogd = signal(false);
  /** `true` wanneer de server om een tweede factor vraagt. */
  readonly mfaVereist = signal(false);
  readonly klaar = computed(() => this.ingelogd() && !this.mfaVereist());

  accessToken(): string | null {
    return this.#access.lees();
  }

  async inloggen(email: string, wachtwoord: string): Promise<void> {
    const antwoord = await firstValueFrom(
      this.#http.post<InlogAntwoord>(
        `${this.#basis}/auth/inloggen`,
        { email, wachtwoord, client: this.#opslag.soort },
        // De refresh-cookie komt mee terug; zonder dit vlaggetje zet de browser
        // hem niet bij een cross-origin API.
        { withCredentials: true },
      ),
    );
    this.#access.zet(antwoord.accessToken);
    this.ingelogd.set(true);
    this.mfaVereist.set(antwoord.mfaVereist === true);
  }

  async verifieerTweedeFactor(code: string): Promise<void> {
    const antwoord = await firstValueFrom(
      this.#http.post<InlogAntwoord>(
        `${this.#basis}/auth/mfa`,
        { code },
        { withCredentials: true },
      ),
    );
    this.#access.zet(antwoord.accessToken);
    this.mfaVereist.set(false);
  }

  /**
   * Wisselt het refresh-token in voor een nieuw access-token. Geeft `null`
   * terug als dat niet lukt — dan is de sessie voorbij.
   *
   * Roep dit niet rechtstreeks aan vanuit meerdere plekken tegelijk; de
   * interceptor gebruikt {@link EnkeleVerversing} om dubbel inwisselen te
   * voorkomen (dat leest de server als tokendiefstal).
   */
  async ververs(): Promise<string | null> {
    try {
      const antwoord = await firstValueFrom(
        this.#http.post<InlogAntwoord>(
          `${this.#basis}/auth/verversen`,
          {},
          { withCredentials: true },
        ),
      );
      this.#access.zet(antwoord.accessToken);
      this.ingelogd.set(true);
      return antwoord.accessToken;
    } catch {
      this.#vergeet();
      return null;
    }
  }

  async uitloggen(): Promise<void> {
    try {
      await firstValueFrom(
        this.#http.post(`${this.#basis}/auth/uitloggen`, {}, { withCredentials: true }),
      );
    } finally {
      // Ook als het endpoint faalt: lokaal is de sessie hoe dan ook voorbij.
      await this.#opslag.wis();
      this.#vergeet();
    }
  }

  apparaten(): Promise<Apparaat[]> {
    return firstValueFrom(this.#http.get<Apparaat[]>(`${this.#basis}/auth/apparaten`));
  }

  #vergeet(): void {
    this.#access.zet(null);
    this.ingelogd.set(false);
    this.mfaVereist.set(false);
  }
}
