import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonNote,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService } from '../kern/auth.service.js';
import type { ApiFout } from '../kern/fout.js';

@Component({
  selector: 'vve-inloggen',
  standalone: true,
  imports: [
    FormsModule,
    IonButton,
    IonContent,
    IonHeader,
    IonInput,
    IonNote,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Inloggen</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      <form (ngSubmit)="verstuur()">
        <ion-input
          label="E-mailadres"
          labelPlacement="stacked"
          fill="outline"
          type="email"
          name="email"
          autocomplete="username"
          [(ngModel)]="email"
        ></ion-input>
        <ion-input
          label="Wachtwoord"
          labelPlacement="stacked"
          fill="outline"
          type="password"
          name="wachtwoord"
          autocomplete="current-password"
          [(ngModel)]="wachtwoord"
        ></ion-input>
        @if (fout(); as f) {
          <ion-text color="danger"
            ><p>{{ f.melding }}</p></ion-text
          >
          @if (f.referentie) {
            <ion-note>Referentie: {{ f.referentie }}</ion-note>
          }
        }
        <ion-button expand="block" type="submit" [disabled]="bezig()">Inloggen</ion-button>
      </form>
    </ion-content>
  `,
})
export class InloggenPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  email = '';
  wachtwoord = '';
  readonly bezig = signal(false);
  readonly fout = signal<ApiFout | null>(null);

  async verstuur(): Promise<void> {
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await this.#auth.inloggen(this.email, this.wachtwoord);
      // Het wachtwoord blijft niet in het component hangen.
      this.wachtwoord = '';
      await this.#router.navigate([this.#auth.mfaVereist() ? '/mfa' : '/portaal']);
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }
}
