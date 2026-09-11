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
import { startRoute } from '../kern/start-route.js';
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
      @if (herstelmodus()) {
        <p>Voer een van uw herstelcodes in. Elke code werkt één keer.</p>
      } @else {
        <p>Voer de zescijferige code uit uw authenticator-app in.</p>
      }
      <form (ngSubmit)="verstuur()">
        <ion-input
          [label]="herstelmodus() ? 'Herstelcode' : 'Code'"
          labelPlacement="stacked"
          fill="outline"
          [inputmode]="herstelmodus() ? 'text' : 'numeric'"
          name="code"
          autocomplete="one-time-code"
          [maxlength]="herstelmodus() ? 32 : 6"
          [(ngModel)]="code"
        ></ion-input>
        @if (fout(); as f) {
          <ion-text color="danger"
            ><p>{{ f.melding }}</p></ion-text
          >
        }
        <!--
          Enter in een invoerveld moet het formulier versturen. De enige
          submit-knop hieronder is een <ion-button>, en diens echte
          <button type="submit"> zit in de shadow DOM — die telt niet mee voor
          de impliciete submit van de browser. Bij twee velden gebeurt er dan
          bij Enter helemaal niets (klikken werkt wel: Ionic geeft de klik zelf
          door). Deze verborgen knop geeft de browser de submit-knop terug die
          hij nodig heeft.
        -->
        <button type="submit" tabindex="-1" aria-hidden="true" style="display: none"></button>
        <ion-button expand="block" type="submit" [disabled]="bezig()">Bevestigen</ion-button>
      </form>

      <!--
        Wie zijn telefoon kwijt is, komt er anders niet meer in. De herstelcodes
        zijn bij het instellen één keer getoond; ze werken elk één keer.
      -->
      <ion-button expand="block" fill="clear" (click)="wisselSoort()">
        {{ herstelmodus() ? 'Toch een code uit de app' : 'Ik gebruik een herstelcode' }}
      </ion-button>
    </ion-content>
  `,
})
export class MfaPage {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  code = '';
  readonly herstelmodus = signal(false);
  readonly bezig = signal(false);
  readonly fout = signal<ApiFout | null>(null);

  wisselSoort(): void {
    this.herstelmodus.update((aan) => !aan);
    this.code = '';
    this.fout.set(null);
  }

  async verstuur(): Promise<void> {
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await this.#auth.verifieerTweedeFactor(
        this.code,
        this.herstelmodus() ? 'herstelcode' : 'code',
      );
      this.code = '';
      await this.#router.navigate([startRoute(await this.#auth.laadProfiel())]);
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }
}
