/**
 * Wooneenheden-scherm van de VvE-beheerder — blok V02 (M2 · AC2.1–2.3).
 *
 * Toont de eenheden van de actieve VvE met hun breukdelen en eigenaren, en
 * de AC2.3-somcontrole: de som van de tellers naast de noemer, met het
 * verschil. Afwijkend is een waarschuwing (geel), geen blokkade — de
 * beheerder kan gewoon doorwerken; misschien zijn nog niet alle eenheden
 * ingevoerd.
 *
 * De actieve VvE komt uit het access-token: bij het openen vraagt de
 * AuthService de server om een token met `vve_id`-claim (van de eerste VvE
 * in het profiel), waarna de eenheden-endpoints hun data leveren.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import type { ApiFout } from '../kern/fout.js';
import { AuthService } from '../kern/auth.service.js';
import { EenhedenService, type EenhedenOverzicht, type EenheidInvoer } from './eenheden.service.js';

const TYPEN = ['woning', 'parkeerplaats', 'berging', 'bedrijfsruimte', 'gemeenschappelijk'];

function leegInvoer(): EenheidInvoer {
  return { code: '', type: 'woning' };
}

@Component({
  selector: 'vve-eenheden',
  standalone: true,
  imports: [
    FormsModule,
    IonBadge,
    IonButton,
    IonCard,
    IonCardContent,
    IonCardHeader,
    IonCardSubtitle,
    IonCardTitle,
    IonContent,
    IonHeader,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonSelect,
    IonSelectOption,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Wooneenheden</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      @if (fout(); as f) {
        <ion-text color="danger"
          ><p>{{ f.melding }}</p></ion-text
        >
      }

      @if (overzicht(); as o) {
        @if (o.verschil !== 0) {
          <ion-note color="warning">
            AC2.3-waarschuwing: de som van de breukdelen is {{ o.somTeller }} van de noemer
            {{ o.noemer }} — verschil {{ o.verschil }}. Dit blokkeert niets, maar de splitsingsakte
            is (nog) niet volledig ingevoerd.
          </ion-note>
        } @else {
          <ion-note color="success">Breukdelen sluiten: {{ o.somTeller }}/{{ o.noemer }}.</ion-note>
        }

        @for (e of o.eenheden; track e.id) {
          <ion-card>
            <ion-card-header>
              <ion-card-title>{{ e.code }}</ion-card-title>
              <ion-card-subtitle
                >{{ e.type }}{{ e.gebouwNaam ? ' · ' + e.gebouwNaam : '' }}</ion-card-subtitle
              >
            </ion-card-header>
            <ion-card-content>
              <ion-list>
                <ion-item>
                  <ion-label>
                    <h3>Breukdeel</h3>
                    <p>{{ e.breukdeelTeller }}/{{ e.breukdeelNoemer }} · {{ e.stemmen }} stemmen</p>
                  </ion-label>
                </ion-item>
                <ion-item>
                  <ion-label>
                    <h3>Oppervlakte</h3>
                    <p>{{ e.oppervlakteM2 ?? 'onbekend' }} m²</p>
                  </ion-label>
                </ion-item>
                <ion-item>
                  <ion-label>
                    <h3>Eigenaren</h3>
                    @for (a of e.eigenaren; track a.persoonId) {
                      <p>
                        {{ a.naam }} ({{ a.aandeelPromille }}‰)
                        {{ a.isPrimairContact ? '· primair contact' : '' }}
                      </p>
                    } @empty {
                      <p>nog niet gekoppeld</p>
                    }
                  </ion-label>
                </ion-item>
              </ion-list>
            </ion-card-content>
          </ion-card>
        } @empty {
          <p>Nog geen eenheden ingevoerd.</p>
        }
      }

      <h2>Nieuwe eenheid</h2>
      <form (ngSubmit)="maakEenheid()">
        <ion-input
          label="Code (bijv. A-12)"
          labelPlacement="stacked"
          fill="outline"
          name="code"
          [(ngModel)]="invoer.code"
          required
        ></ion-input>
        <ion-item>
          <ion-select label="Type" labelPlacement="stacked" name="type" [(ngModel)]="invoer.type">
            @for (t of typen; track t) {
              <ion-select-option [value]="t">{{ t }}</ion-select-option>
            }
          </ion-select>
        </ion-item>
        <ion-input
          label="Gebouw/blok (optioneel)"
          labelPlacement="stacked"
          fill="outline"
          name="gebouwNaam"
          [(ngModel)]="invoer.gebouwNaam"
        ></ion-input>
        <ion-input
          label="Breukdeel teller"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="breukdeelTeller"
          [(ngModel)]="invoer.breukdeelTeller"
        ></ion-input>
        <ion-input
          label="Breukdeel noemer"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="breukdeelNoemer"
          [(ngModel)]="invoer.breukdeelNoemer"
        ></ion-input>
        <ion-input
          label="Oppervlakte in m²"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="oppervlakteM2"
          [(ngModel)]="invoer.oppervlakteM2"
        ></ion-input>
        <ion-button expand="block" [disabled]="bezig()" type="submit">Eenheid toevoegen</ion-button>
      </form>
    </ion-content>
  `,
})
export class EenhedenPage {
  readonly #auth = inject(AuthService);
  readonly #service = inject(EenhedenService);

  readonly overzicht = signal<EenhedenOverzicht | null>(null);
  readonly fout = signal<ApiFout | null>(null);
  readonly bezig = signal(false);
  readonly invoer = signal<EenheidInvoer>(leegInvoer());
  readonly typen = TYPEN;

  /** Zodat ngModel met nummerinvoer omgaat zonder lege-string-crashes. */
  invoerModel = leegInvoer();

  constructor() {
    void this.laad();
  }

  async laad(): Promise<void> {
    this.bezig.set(true);
    try {
      await this.#auth.kiesActieveVveVanEerste();
      this.overzicht.set(await this.#service.lijst());
    } catch (e) {
      this.fout.set(e as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }

  async maakEenheid(): Promise<void> {
    const velden = this.invoerModel;
    if (velden.code.trim() === '') return;
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await this.#service.maak(velden);
      this.invoerModel = leegInvoer();
      this.overzicht.set(await this.#service.lijst());
    } catch (e) {
      this.fout.set(e as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }
}
