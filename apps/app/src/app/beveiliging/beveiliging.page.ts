/**
 * Beveiligingsscherm — de tweede factor instellen (F07, spec §7.6/§8.5).
 *
 * Eigen route en geen sectie op het portaal, om een simpele reden: het portaal
 * is het scherm van de eigenaar, en juist de twee rollen die de tweede factor
 * nodig hebben — de applicatiebeheerder en de VvE-beheerder — komen daar nooit.
 * Die landen op `/beheer` respectievelijk `/vve`. Een instelling die alleen
 * bereikbaar is voor wie hem niet nodig heeft, is geen instelling.
 *
 * Het secret en de herstelcodes komen één keer langs en worden nergens
 * bewaard — dezelfde afspraak als bij de wachtwoorduitgifte in het beheer
 * (V01). In de database staat het secret versleuteld en staan de herstelcodes
 * gehasht; opnieuw opvragen kan niet, opnieuw uitgeven wel.
 */
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService, type MfaStatus, type TotpActivatie } from '../kern/auth.service.js';
import type { ApiFout } from '../kern/fout.js';

@Component({
  selector: 'vve-beveiliging',
  standalone: true,
  imports: [
    IonBadge,
    IonButton,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Beveiliging</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      @if (fout(); as f) {
        <ion-text color="danger"
          ><p>{{ f.melding }}</p></ion-text
        >
      }

      <h2>Tweede factor</h2>
      @if (status(); as m) {
        <ion-list>
          <ion-item>
            <ion-label>
              <h3>{{ m.actief ? 'Ingesteld' : 'Nog niet ingesteld' }}</h3>
              @if (m.actief) {
                <p>
                  {{ m.totp ? 'Authenticator-app' : '' }}
                  {{ m.passkeys > 0 ? m.passkeys + ' passkey(s)' : '' }}
                </p>
              } @else {
                <p>
                  Zonder tweede factor worden handelingen met geld geweigerd: incasso,
                  IBAN-wijziging, gebruikersrollen en het afsluiten van een boekjaar.
                </p>
              }
            </ion-label>
            <ion-badge slot="end" [color]="m.actief ? 'success' : 'warning'">
              {{ m.actief ? 'actief' : 'uit' }}
            </ion-badge>
          </ion-item>
        </ion-list>

        @if (!m.actief) {
          <ion-button expand="block" (click)="activeer()" [disabled]="bezig()">
            Authenticator-app instellen
          </ion-button>
        }
      } @else {
        <p>Bezig met laden…</p>
      }

      @if (activatie(); as a) {
        <div class="uitgifte">
          <h3>Noteer dit nu — het is niet opnieuw op te vragen</h3>
          <p>Voer deze sleutel in uw authenticator-app in:</p>
          <p class="geheim">{{ a.secret }}</p>
          <ion-button size="small" fill="outline" (click)="kopieer(a.secret)">
            Kopieer sleutel
          </ion-button>

          <p>Herstelcodes — elk één keer bruikbaar, voor als u uw telefoon kwijt bent:</p>
          <p class="geheim">{{ a.herstelcodes.join('  ') }}</p>
          <ion-button size="small" fill="outline" (click)="kopieer(a.herstelcodes.join(' '))">
            Kopieer herstelcodes
          </ion-button>
          <ion-button size="small" fill="clear" (click)="activatie.set(null)">Sluiten</ion-button>
        </div>
      }

      <ion-note>
        De tweede factor beschermt alleen de geldhandelingen. Inloggen op het portaal blijft werken
        met alleen uw wachtwoord.
      </ion-note>

      <ion-button expand="block" fill="clear" (click)="terug()">Terug</ion-button>
    </ion-content>
  `,
  styles: [
    `
      .uitgifte {
        border: 2px solid var(--ion-color-warning, #e0ac08);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
      }
      .geheim {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 1.05rem;
        user-select: all;
        word-break: break-all;
      }
    `,
  ],
})
export class BeveiligingPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  readonly status = signal<MfaStatus | null>(null);
  /** Het zojuist uitgereikte secret; alleen in beeld, nooit opgeslagen. */
  readonly activatie = signal<TotpActivatie | null>(null);
  readonly bezig = signal(false);
  readonly fout = signal<ApiFout | null>(null);

  constructor() {
    void this.#laad();
  }

  async #laad(): Promise<void> {
    try {
      this.status.set(await this.#auth.mfaStatus());
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    }
  }

  async activeer(): Promise<void> {
    this.bezig.set(true);
    this.fout.set(null);
    try {
      this.activatie.set(await this.#auth.activeerTotp());
      await this.#laad();
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }

  async kopieer(tekst: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(tekst);
    } catch {
      // Kopiëren mag mislukken (geen toestemming); de tekst staat in beeld.
    }
  }

  async terug(): Promise<void> {
    await this.#router.navigate(['/']);
  }
}
