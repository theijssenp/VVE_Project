import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService, type Apparaat } from '../kern/auth.service.js';
import { PortaalService, type PortaalGegevens, type PortaalOverzicht } from './portaal.service.js';

/** Centen → euro-tekst; de client rekent nooit met centen (F12-discipline). */
function euro(centen: number): string {
  const negatief = centen < 0;
  const abs = Math.abs(centen);
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${negatief ? '-' : ''}€ ${String(euros)},${rest}`;
}

@Component({
  selector: 'vve-portaal',
  standalone: true,
  imports: [
    RouterLink,
    FormsModule,
    IonBadge,
    IonButton,
    IonContent,
    IonHeader,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonSelect,
    IonSelectOption,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Mijn VvE</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      <!-- Mijn eenheden: aandeel, openstaand saldo en creditsaldo -->
      <h2>Mijn eenheden</h2>
      <ion-list>
        @for (e of overzicht()?.eenheden ?? []; track e.eenheidId) {
          <ion-item>
            <ion-label>
              <h3>{{ e.code }} — {{ e.type }}</h3>
              <p>
                Aandeel {{ e.aandeelPromille }}‰ · breukdeel {{ e.breukdeelTeller }}/{{
                  e.breukdeelNoemer
                }}
                @if (e.isPrimairContact) {
                  · primair contact
                }
              </p>
              <p>
                Openstaand: {{ euro(e.openstaandCenten) }}
                @if (e.creditSaldoCenten > 0) {
                  · vooruitbetaald: {{ euro(e.creditSaldoCenten) }}
                }
                @if (e.oudsteVervaldatum !== null) {
                  · vervalt {{ e.oudsteVervaldatum }}
                }
              </p>
            </ion-label>
          </ion-item>
        } @empty {
          <ion-item>
            <ion-label>Je bent (nu) geen eigenaar van een eenheid in deze VvE.</ion-label>
          </ion-item>
        }
      </ion-list>

      <!-- Laatste betalingen -->
      <h2>Laatste betalingen</h2>
      <ion-list>
        @for (b of overzicht()?.betalingen ?? []; track b.id) {
          <ion-item>
            <ion-label>
              <h3>{{ euro(b.bedragCent) }} — {{ b.datum }}</h3>
              <p>{{ b.omschrijving ?? b.bron }} · gekoppeld {{ euro(b.gekoppeldCenten) }}</p>
            </ion-label>
          </ion-item>
        } @empty {
          <ion-item><ion-label>Nog geen betalingen.</ion-label></ion-item>
        }
      </ion-list>

      <!-- Laatste mededelingen -->
      <h2>Mededelingen</h2>
      <ion-list>
        @for (m of overzicht()?.mededelingen ?? []; track m.id) {
          <ion-item>
            <ion-label>
              <h3>{{ m.titel }}</h3>
              <p>{{ m.inhoud }}</p>
              <p>{{ m.gepubliceerdOp }}</p>
            </ion-label>
          </ion-item>
        } @empty {
          <ion-item><ion-label>Geen mededelingen.</ion-label></ion-item>
        }
      </ion-list>

      <!-- AC14.3: eigen gegevens -->
      <h2>Mijn gegevens</h2>
      <ion-list>
        <ion-item>
          <ion-input label="Voornaam" [(ngModel)]="gegevensVoornaam" />
        </ion-item>
        <ion-item>
          <ion-input label="Tussenvoegsel" [(ngModel)]="gegevensTussenvoegsel" />
        </ion-item>
        <ion-item>
          <ion-input label="Achternaam" [(ngModel)]="gegevensAchternaam" />
        </ion-item>
        <ion-item>
          <ion-input label="Telefoon" [(ngModel)]="gegevensTelefoon" />
        </ion-item>
        <ion-item>
          <ion-input label="Straat" [(ngModel)]="gegevensStraat" />
        </ion-item>
        <ion-item>
          <ion-input label="Huisnummer" [(ngModel)]="gegevensHuisnummer" />
        </ion-item>
        <ion-item>
          <ion-input label="Postcode" [(ngModel)]="gegevensPostcode" />
        </ion-item>
        <ion-item>
          <ion-input label="Plaats" [(ngModel)]="gegevensPlaats" />
        </ion-item>
        <ion-item>
          <ion-select label="Communicatie" [(ngModel)]="gegevensWijze">
            <ion-select-option value="email">E-mail</ion-select-option>
            <ion-select-option value="post">Post</ion-select-option>
            <ion-select-option value="beide">Beide</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-label slot="end">{{ gegevens()?.email }}</ion-label>
        </ion-item>
      </ion-list>
      <ion-button expand="block" (click)="bewaarGegevens()">Gegevens bewaren</ion-button>

      <h2>Mijn apparaten</h2>
      <ion-list>
        @for (a of apparaten(); track a.sessieId) {
          <ion-item>
            <ion-label>
              <h3>{{ a.apparaatNaam ?? a.platform ?? 'Onbekend apparaat' }}</h3>
              <p>Laatst gebruikt: {{ a.laatsteGebruiktOp ?? 'onbekend' }}</p>
            </ion-label>
            <ion-badge slot="end" [color]="a.actief ? 'success' : 'medium'">
              {{ a.actief ? 'actief' : 'ingetrokken' }}
            </ion-badge>
          </ion-item>
        } @empty {
          <ion-item><ion-label>Geen apparaten gevonden.</ion-label></ion-item>
        }
      </ion-list>

      <!--
        Beheer is alleen voor de applicatiebeheerder. De API weigerde de rest al
        met 403, maar een knop die voor iedereen zichtbaar is en voor bijna
        niemand werkt, is een foutmelding als functionaliteit. Nu tonen we hem
        alleen aan wie hem mag gebruiken; de 403 blijft als vangnet staan.
      -->
      @if (isApplicatiebeheerder()) {
        <ion-button expand="block" routerLink="/beheer">VvE-beheer</ion-button>
      }
      @if (heeftVveRol()) {
        <ion-button expand="block" routerLink="/vve">Mijn VvE</ion-button>
      }
      <ion-button expand="block" fill="outline" routerLink="/beveiliging">Beveiliging</ion-button>
      <ion-button expand="block" fill="outline" (click)="uitloggen()">Uitloggen</ion-button>
    </ion-content>
  `,
})
export class PortaalPage {
  readonly #auth = inject(AuthService);
  readonly #portaal = inject(PortaalService);
  readonly #router = inject(Router);
  readonly apparaten = signal<Apparaat[]>([]);
  readonly overzicht = signal<PortaalOverzicht | null>(null);
  readonly gegevens = signal<PortaalGegevens | null>(null);

  // Bewerkbare velden (AC14.3); ngModel schrijft hier, bewaarGegevens leest.
  gegevensVoornaam = '';
  gegevensTussenvoegsel = '';
  gegevensAchternaam = '';
  gegevensTelefoon = '';
  gegevensStraat = '';
  gegevensHuisnummer = '';
  gegevensPostcode = '';
  gegevensPlaats = '';
  gegevensWijze = 'email';

  readonly isApplicatiebeheerder = computed(
    () => this.#auth.profiel()?.isApplicatiebeheerder === true,
  );
  readonly heeftVveRol = computed(() => (this.#auth.profiel()?.vves.length ?? 0) > 0);

  constructor() {
    void this.#laad();
  }

  euro = euro;

  async #laad(): Promise<void> {
    try {
      this.apparaten.set(await this.#auth.apparaten());
    } catch {
      // De lijst is bijzaak op dit scherm; een fout mag het portaal niet blokkeren.
      this.apparaten.set([]);
    }
    try {
      // Het profiel bepaalt welke knoppen hier horen. Mislukt het, dan blijven
      // ze weg — liever een knop te weinig dan een knop die op een 403 uitkomt.
      if (this.#auth.profiel() === null) await this.#auth.laadProfiel();
    } catch {
      // Bewust stil: het portaal zelf werkt ook zonder profiel.
    }
    try {
      this.overzicht.set(await this.#portaal.overzicht());
    } catch {
      // Geen eenheden in deze VvE of geen toegang: het scherm toont de lege
      // toestand; de secties betalingen/mededelingen blijven ook leeg.
      this.overzicht.set(null);
    }
    try {
      const g = await this.#portaal.gegevens();
      this.gegevens.set(g);
      this.gegevensVoornaam = g.voornaam ?? '';
      this.gegevensTussenvoegsel = g.tussenvoegsel ?? '';
      this.gegevensAchternaam = g.achternaam;
      this.gegevensTelefoon = g.telefoon ?? '';
      this.gegevensStraat = g.corrStraat ?? '';
      this.gegevensHuisnummer = g.corrHuisnummer ?? '';
      this.gegevensPostcode = g.corrPostcode ?? '';
      this.gegevensPlaats = g.corrPlaats ?? '';
      this.gegevensWijze = g.communicatieWijze;
    } catch {
      this.gegevens.set(null);
    }
  }

  async bewaarGegevens(): Promise<void> {
    try {
      const na = await this.#portaal.wijzigGegevens({
        voornaam: this.gegevensVoornaam,
        tussenvoegsel: this.gegevensTussenvoegsel,
        achternaam: this.gegevensAchternaam,
        telefoon: this.gegevensTelefoon,
        corrStraat: this.gegevensStraat,
        corrHuisnummer: this.gegevensHuisnummer,
        corrPostcode: this.gegevensPostcode,
        corrPlaats: this.gegevensPlaats,
        communicatieWijze: this.gegevensWijze,
      });
      this.gegevens.set(na);
    } catch {
      // De API-foutfilter toont de melding; hier niets stil afhandelen.
    }
  }

  async uitloggen(): Promise<void> {
    await this.#auth.uitloggen();
    await this.#router.navigate(['/inloggen']);
  }
}
