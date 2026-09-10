import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService } from '../kern/auth.service.js';
import type { ApiFout } from '../kern/fout.js';

@Component({
  selector: 'vve-mfa',
  standalone: true,
  imports: [FormsModule, IonButton, IonContent, IonHeader, IonInput, IonText, IonTitle, IonToolbar],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Tweede factor</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      <p>Voer de zescijferige code uit uw authenticator-app in.</p>
      <form (ngSubmit)="verstuur()">
        <ion-input
          label="Code"
          labelPlacement="stacked"
          fill="outline"
          inputmode="numeric"
          name="code"
          autocomplete="one-time-code"
          maxlength="6"
          [(ngModel)]="code"
        ></ion-input>
        @if (fout(); as f) {
          <ion-text color="danger"
            ><p>{{ f.melding }}</p></ion-text
          >
        }
        <ion-button expand="block" type="submit" [disabled]="bezig()">Bevestigen</ion-button>
      </form>
    </ion-content>
  `,
})
export class MfaPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  code = '';
  readonly bezig = signal(false);
  readonly fout = signal<ApiFout | null>(null);

  async verstuur(): Promise<void> {
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await this.#auth.verifieerTweedeFactor(this.code);
      this.code = '';
      await this.#router.navigate(['/portaal']);
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }
}
