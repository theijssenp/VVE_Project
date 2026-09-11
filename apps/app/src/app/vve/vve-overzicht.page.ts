/**
 * Startscherm van de VvE-beheerder — de schil waar iemand met een lopende
 * beheerrol na het inloggen uitkomt.
 *
 * Nadrukkelijk niet de beheeromgeving (`/beheer`): daar worden VvE's opgevoerd
 * en beheerderswachtwoorden uitgereikt, en dat is voorbehouden aan de
 * applicatiebeheerder.
 *
 * De spec (§9) wil hier op termijn een actielijst en geen leeg dashboard:
 * openstaande posten boven een drempel, ongematchte banktransacties,
 * verlopende polissen, ALV zonder notulen, een niet-afgesloten boekjaar, een
 * dotatie onder de wettelijke norm, mandaten met stornos. Geen van die
 * gegevens bestaat nu — eenheden komen in V02, de financiële blokken daarna.
 * Daarom toont dit scherm wat er werkelijk is en zegt het er eerlijk bij wat
 * nog volgt, in plaats van lege tegels met nullen te tonen die suggereren dat
 * er niets aan de hand is.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService } from '../kern/auth.service.js';

const MAANDEN = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
];

@Component({
  selector: 'vve-overzicht',
  standalone: true,
  imports: [
    IonBadge,
    IonButton,
    IonCard,
    IonCardContent,
    IonCardHeader,
    IonCardSubtitle,
    IonCardTitle,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Mijn VvE</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      @if (profiel(); as p) {
        <p>Welkom {{ p.naam }}.</p>
      }

      @for (v of vves(); track v.vveId) {
        <ion-card>
          <ion-card-header>
            <ion-card-title>{{ v.naam }}</ion-card-title>
            <ion-card-subtitle>
              {{ v.plaats ?? 'plaats onbekend' }} · uw rol: {{ v.rol }}
            </ion-card-subtitle>
          </ion-card-header>
          <ion-card-content>
            <ion-list>
              <ion-item>
                <ion-label>
                  <h3>Boekjaar</h3>
                  <p>begint in {{ maand(v.boekjaarStartmaand) }}</p>
                </ion-label>
                <ion-badge slot="end" [color]="v.status === 'actief' ? 'success' : 'medium'">
                  {{ v.status }}
                </ion-badge>
              </ion-item>
            </ion-list>

            @if (v.status === 'gearchiveerd') {
              <ion-note color="warning">
                Deze VvE is gearchiveerd. Neem contact op met de applicatiebeheerder om hem weer
                actief te maken.
              </ion-note>
            }
          </ion-card-content>
        </ion-card>
      } @empty {
        <p>Er is geen VvE aan uw account gekoppeld.</p>
      }

      <ion-note>
        De actielijst van dit scherm — openstaande posten, ongematchte banktransacties, verlopende
        polissen, ALV zonder notulen — volgt zodra de bijbehorende onderdelen gebouwd zijn. Wat u
        hier ziet, is alles wat er nu werkelijk over uw VvE is vastgelegd.
      </ion-note>

      <ion-button expand="block" fill="outline" (click)="uitloggen()">Uitloggen</ion-button>
    </ion-content>
  `,
})
export class VveOverzichtPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  readonly profiel = this.#auth.profiel;
  readonly vves = computed(() => this.profiel()?.vves ?? []);
  readonly bezig = signal(false);

  maand(nummer: number): string {
    return MAANDEN[nummer - 1] ?? `maand ${String(nummer)}`;
  }

  async uitloggen(): Promise<void> {
    await this.#auth.uitloggen();
    await this.#router.navigate(['/inloggen']);
  }
}
