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
import { EnkeleVerversing, metTijdslimiet } from './verversing.js';

/**
 * Hoe lang het opstarten hoogstens op het herstellen van de sessie wacht.
 * Ruim genoeg voor een trage verbinding, kort genoeg om geen wit scherm te zijn.
 */
const HERSTEL_LIMIET_MS = 8000;

export interface InlogAntwoord {
  readonly accessToken: string;
  readonly mfaVereist?: boolean;
}

/** Eén VvE waar deze persoon een lopende rol in heeft. */
export interface ProfielVve {
  readonly vveId: string;
  readonly naam: string;
  readonly plaats: string | null;
  readonly status: 'actief' | 'gearchiveerd';
  readonly boekjaarStartmaand: number;
  readonly rol: string;
}

/**
 * Wie is ingelogd — bepaalt welk startscherm de gebruiker krijgt.
 *
 * Komt van `GET /auth/mij` en niet uit het access-token: rollen in een token
 * verouderen stil. Dit is ook géén autorisatie — de server weigert een
 * beheerroute hoe dan ook met 403; dit stuurt alleen de navigatie, zodat
 * niemand op een scherm belandt waar hij niets te zoeken heeft.
 */
export interface Profiel {
  readonly persoonId: string;
  readonly email: string;
  readonly naam: string;
  readonly isApplicatiebeheerder: boolean;
  readonly wachtwoordWijzigenVerplicht: boolean;
  readonly vves: readonly ProfielVve[];
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
  /**
   * Eén poort voor álle verversingen — zowel de 401-afhandeling in de
   * interceptor als het herstel bij opstarten. Twee paden die onafhankelijk van
   * elkaar hetzelfde refresh-token inwisselen, zijn voor de server niet van
   * tokendiefstal te onderscheiden: die trekt dan de hele familie in en logt de
   * gebruiker overal uit (§7.6).
   */
  readonly #verversing = new EnkeleVerversing();

  /** `true` zodra er een bruikbaar access-token is. */
  readonly ingelogd = signal(false);
  /** `true` wanneer de server om een tweede factor vraagt. */
  readonly mfaVereist = signal(false);
  /** Het profiel van de ingelogde gebruiker; `null` zolang het niet geladen is. */
  readonly profiel = signal<Profiel | null>(null);
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

  /**
   * Zorgt dat het access-token de actieve VvE draagt (spec §7.5 stap 2).
   *
   * Neemt de eerste VvE uit het profiel (de applicatie kent nog geen
   * VvE-wissel op de sessie) en vraagt de server om een nieuw access-token
   * met `vve_id`-claim. Faalt dat — geen rol, onbekende VvE — dan blijft het
   * token zonder claim en weigert de server de tenant-scoped routes, zoals
   * bedoeld.
   */
  async kiesActieveVve(vveId: string): Promise<void> {
    const antwoord = await firstValueFrom(
      this.#http.post<{ accessToken: string }>(
        `${this.#basis}/auth/actieve-vve`,
        { vveId },
        { withCredentials: true },
      ),
    );
    this.#access.zet(antwoord.accessToken);
  }

  /** Gemak voor het startscherm: de eerste VvE uit het profiel kiezen. */
  async kiesActieveVveVanEerste(): Promise<void> {
    const eerste = this.profiel()?.vves[0]?.vveId;
    if (eerste === undefined) {
      throw new Error('Geen VvE in het profiel om als actief te kiezen.');
    }
    await this.kiesActieveVve(eerste);
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

  /**
   * Haalt het profiel op en bewaart het. Roep dit na elke inlog en na elke
   * verversing: wie tussendoor van rol wisselt, hoort dat bij de volgende
   * navigatie te merken en niet pas na opnieuw inloggen.
   */
  async laadProfiel(): Promise<Profiel> {
    const profiel = await firstValueFrom(this.#http.get<Profiel>(`${this.#basis}/auth/mij`));
    this.profiel.set(profiel);
    return profiel;
  }

  /**
   * Ververst, of sluit aan bij een verversing die al loopt. Dit is het enige
   * pad dat de rest van de applicatie hoort te gebruiken; {@link ververs} zelf
   * is de ongebufferde variant eronder.
   */
  verversEenmalig(): Promise<string | null> {
    return this.#verversing.voerUit(() => this.ververs());
  }

  /**
   * Herstelt de sessie bij het opstarten van de applicatie (§7.6).
   *
   * Het access-token staat alleen in het geheugen en is na een herlaad dus weg;
   * het refresh-token zit in een httpOnly-cookie en overleeft wél. Zonder deze
   * stap belandt iedereen na F5 op het inlogscherm terwijl er een geldige
   * sessie ligt. Faalt het — geen cookie, verlopen sessie, server onbereikbaar —
   * dan blijft de gebruiker uitgelogd en doet de routebewaking de rest.
   */
  async herstelSessie(): Promise<void> {
    if (this.ingelogd()) return;
    const token = await metTijdslimiet(this.verversEenmalig(), HERSTEL_LIMIET_MS, null);
    if (token === null) return;
    try {
      await this.laadProfiel();
    } catch {
      // Wel een token, maar geen profiel: dan weten we niet wie dit is en
      // hoort de gebruiker opnieuw in te loggen in plaats van half binnen te zijn.
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
    this.profiel.set(null);
  }
}
