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
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService, type Apparaat } from '../kern/auth.service.js';

@Component({
  selector: 'vve-portaal',
  standalone: true,
  imports: [
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

      <ion-button expand="block" fill="outline" (click)="uitloggen()">Uitloggen</ion-button>
    </ion-content>
  `,
})
export class PortaalPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);
  readonly apparaten = signal<Apparaat[]>([]);

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
  }

  async uitloggen(): Promise<void> {
    await this.#auth.uitloggen();
    await this.#router.navigate(['/inloggen']);
  }
}
