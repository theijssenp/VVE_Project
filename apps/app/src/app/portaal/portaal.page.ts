import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService, type Apparaat } from '../kern/auth.service.js';

@Component({
  selector: 'vve-portaal',
  standalone: true,
  imports: [
    RouterLink,
    IonBadge,
    IonButton,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Mijn VvE</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      <p>Welkom. De onderdelen van het portaal volgen in fase 1 (blok V07).</p>

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
      <ion-button expand="block" fill="outline" (click)="uitloggen()">Uitloggen</ion-button>
    </ion-content>
  `,
})
export class PortaalPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly apparaten = signal<Apparaat[]>([]);

  readonly isApplicatiebeheerder = computed(
    () => this.#auth.profiel()?.isApplicatiebeheerder === true,
  );
  readonly heeftVveRol = computed(() => (this.#auth.profiel()?.vves.length ?? 0) > 0);

  constructor() {
    void this.#laad();
  }

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
  }

  async uitloggen(): Promise<void> {
    await this.#auth.uitloggen();
    await this.#router.navigate(['/inloggen']);
  }
}
