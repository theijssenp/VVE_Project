/**
 * Registratiescherm — blok V04 (AC2.2, §3.3).
 *
 * De landingspagina van de uitnodigingslink (`/registratie?token=…`):
 * het token zit in de URL, de persoon kiest hier zijn wachtwoord. Het
 * access-token dat de registratie oplevert wordt bewust NIET in de sessie
 * gezet — de gebruiker logt daarna gewoon in; zo blijft het inlogpad één
 * pad (§7.6) en kan een gedeelde computer niet half-ingedragen achterblijven.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
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
import { ActivatedRoute, Router } from '@angular/router';

import type { ApiFout } from '../kern/fout.js';
import { API_BASIS } from '../kern/tokens.js';

@Component({
  selector: 'vve-registratie',
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
      ><ion-toolbar><ion-title>Account instellen</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      @if (gelukt()) {
        <h2>Je account is ingesteld.</h2>
        <p>Je kunt nu inloggen met het wachtwoord dat je zojuist hebt gekozen.</p>
        <ion-button expand="block" (click)="naarInloggen()">Naar inloggen</ion-button>
      } @else {
        @if (fout(); as f) {
          <ion-text color="danger"
            ><p>{{ f.melding }}</p></ion-text
          >
        }
        <form (ngSubmit)="registreer()">
          <ion-input
            label="Kies een wachtwoord (minimaal 12 tekens)"
            labelPlacement="stacked"
            fill="outline"
            type="password"
            name="wachtwoord"
            [(ngModel)]="wachtwoord"
            required
          ></ion-input>
          <ion-button expand="block" [disabled]="bezig() || token() === ''" type="submit"
            >Wachtwoord instellen</ion-button
          >
        </form>
        @if (token() === '') {
          <ion-note color="warning">
            Er ontbreekt een uitnodigingstoken. Gebruik de link uit je uitnodigingsmail.
          </ion-note>
        }
      }
    </ion-content>
  `,
})
export class RegistratiePage {
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #http = inject(HttpClient);
  readonly #basis = inject(API_BASIS);

  readonly token = signal('');
  readonly gelukt = signal(false);
  readonly fout = signal<ApiFout | null>(null);
  readonly bezig = signal(false);
  wachtwoord = '';

  constructor() {
    this.#route.queryParamMap.subscribe((params) => {
      this.token.set(params.get('token') ?? '');
    });
  }

  /** Na het instellen gaat de gebruiker gewoon door het normale inlogpad (§7.6). */
  async naarInloggen(): Promise<void> {
    await this.#router.navigate(['/inloggen']);
  }

  async registreer(): Promise<void> {
    if (this.wachtwoord.length < 12 || this.token() === '') return;
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await firstValueFrom(
        this.#http.post(`${this.#basis}/registratie`, {
          token: this.token(),
          wachtwoord: this.wachtwoord,
        }),
      );
      this.gelukt.set(true);
    } catch (e) {
      this.fout.set(e as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }
}
