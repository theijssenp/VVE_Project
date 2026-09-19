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
 * AuthService de server om een token met `vve_id`-claim, waarna de
 * eenheden-endpoints hun data leveren. Welke VvE dat is, staat in de
 * query-parameter `vve` die het startscherm meegeeft; ontbreekt die, dan is
 * het de eerste VvE uit het profiel.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCheckbox,
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
import {
  EenhedenService,
  type EenhedenOverzicht,
  type EenheidInvoer,
  type EigenaarAccountInvoer,
} from './eenheden.service.js';

const TYPEN = ['woning', 'parkeerplaats', 'berging', 'bedrijfsruimte', 'gemeenschappelijk'];

function leegInvoer(): EenheidInvoer {
  return { code: '', type: 'woning' };
}

function leegEigenaar(): EigenaarAccountInvoer {
  return { email: '', achternaam: '', wachtwoord: '', aandeelPromille: 1000 };
}

@Component({
  selector: 'vve-eenheden',
  standalone: true,
  imports: [
    FormsModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonCard,
    IonCardContent,
    IonCheckbox,
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
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"
          ><ion-back-button defaultHref="/vve"></ion-back-button
        ></ion-buttons>
        <ion-title>Wooneenheden</ion-title>
      </ion-toolbar>
    </ion-header>
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

              @if (uitgereikt(); as u) {
                @if (u.eenheidId === e.id) {
                  <!--
                    De inloggegevens staan hier één keer, want ze zijn nergens
                    anders op te halen: er gaat geen mail uit zolang SMTP niet
                    werkt, en het wachtwoord is in de database alleen als hash
                    aanwezig. Kwijt is kwijt — dan opnieuw uitreiken.
                  -->
                  <ion-note color="success">
                    <p>
                      <strong>Toegang aangemaakt voor {{ e.code }}.</strong>
                    </p>
                    <p>Gebruikersnaam: {{ u.email }}</p>
                    <p>Wachtwoord: {{ u.wachtwoord }}</p>
                    <p>
                      Geef dit persoonlijk door. Het wordt hierna niet meer getoond en de eigenaar
                      moet het bij de eerste inlog zelf wijzigen.
                    </p>
                  </ion-note>
                }
              }

              @if (openEenheidId() === e.id) {
                <form (ngSubmit)="geefToegang(e.id)">
                  <ion-input
                    label="E-mailadres van de eigenaar"
                    labelPlacement="stacked"
                    fill="outline"
                    type="email"
                    [name]="'email-' + e.id"
                    [ngModel]="eigenaarModel().email"
                    (ngModelChange)="zetEigenaarVeld('email', $event)"
                    required
                  ></ion-input>
                  <ion-input
                    label="Achternaam"
                    labelPlacement="stacked"
                    fill="outline"
                    [name]="'achternaam-' + e.id"
                    [ngModel]="eigenaarModel().achternaam"
                    (ngModelChange)="zetEigenaarVeld('achternaam', $event)"
                    required
                  ></ion-input>
                  <ion-input
                    label="Voornaam (optioneel)"
                    labelPlacement="stacked"
                    fill="outline"
                    [name]="'voornaam-' + e.id"
                    [ngModel]="eigenaarModel().voornaam"
                    (ngModelChange)="zetEigenaarVeld('voornaam', $event)"
                  ></ion-input>
                  <ion-input
                    label="Wachtwoord"
                    labelPlacement="stacked"
                    fill="outline"
                    [name]="'wachtwoord-' + e.id"
                    [ngModel]="eigenaarModel().wachtwoord"
                    (ngModelChange)="zetEigenaarVeld('wachtwoord', $event)"
                    required
                  ></ion-input>
                  <ion-button size="small" fill="clear" type="button" (click)="nieuwVoorstel()">
                    Ander wachtwoord voorstellen
                  </ion-button>
                  <ion-input
                    label="Aandeel in promille"
                    labelPlacement="stacked"
                    fill="outline"
                    type="number"
                    [name]="'aandeel-' + e.id"
                    [ngModel]="eigenaarModel().aandeelPromille"
                    (ngModelChange)="zetEigenaarVeld('aandeelPromille', $event)"
                  ></ion-input>
                  <ion-item>
                    <ion-checkbox
                      [name]="'primair-' + e.id"
                      [ngModel]="eigenaarModel().isPrimairContact"
                      (ngModelChange)="zetEigenaarVeld('isPrimairContact', $event)"
                    >
                      Primair contact voor de nota's
                    </ion-checkbox>
                  </ion-item>
                  <ion-button expand="block" [disabled]="bezig()" type="submit">
                    Toegang aanmaken
                  </ion-button>
                  <ion-button expand="block" fill="clear" type="button" (click)="sluitFormulier()">
                    Annuleren
                  </ion-button>
                </form>
              } @else {
                <ion-button expand="block" fill="outline" (click)="openFormulier(e.id)">
                  Eigenaar toegang geven
                </ion-button>
              }
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
          [(ngModel)]="invoerModel.code"
          required
        ></ion-input>
        <ion-item>
          <ion-select
            label="Type"
            labelPlacement="stacked"
            name="type"
            [(ngModel)]="invoerModel.type"
          >
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
          [(ngModel)]="invoerModel.gebouwNaam"
        ></ion-input>
        <ion-input
          label="Breukdeel teller"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="breukdeelTeller"
          [(ngModel)]="invoerModel.breukdeelTeller"
        ></ion-input>
        <ion-input
          label="Breukdeel noemer"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="breukdeelNoemer"
          [(ngModel)]="invoerModel.breukdeelNoemer"
        ></ion-input>
        <ion-input
          label="Oppervlakte in m²"
          labelPlacement="stacked"
          fill="outline"
          type="number"
          name="oppervlakteM2"
          [(ngModel)]="invoerModel.oppervlakteM2"
        ></ion-input>
        <ion-button expand="block" [disabled]="bezig()" type="submit">Eenheid toevoegen</ion-button>
      </form>
    </ion-content>
  `,
})
export class EenhedenPage {
  readonly #auth = inject(AuthService);
  readonly #service = inject(EenhedenService);
  readonly #route = inject(ActivatedRoute);

  readonly overzicht = signal<EenhedenOverzicht | null>(null);
  readonly fout = signal<ApiFout | null>(null);
  readonly bezig = signal(false);
  readonly typen = TYPEN;

  /** Zodat ngModel met nummerinvoer omgaat zonder lege-string-crashes. */
  invoerModel = leegInvoer();

  /** Welke eenheidskaart heeft het toegangsformulier open? Er is er één tegelijk. */
  readonly openEenheidId = signal<string | null>(null);

  /**
   * Een signal, geen gewoon veld: het wachtwoordvoorstel komt ná een
   * serveraanroep binnen, en dan moet het veld zichzelf bijwerken. Met een
   * gewone toewijzing bleef de invoer leeg staan.
   */
  readonly eigenaarModel = signal<EigenaarAccountInvoer>(leegEigenaar());

  zetEigenaarVeld<S extends keyof EigenaarAccountInvoer>(
    sleutel: S,
    waarde: EigenaarAccountInvoer[S],
  ): void {
    this.eigenaarModel.update((huidig) => ({ ...huidig, [sleutel]: waarde }));
  }

  /**
   * De uitgereikte inloggegevens, om ze één keer te kunnen tonen. Ze staan
   * bewust alleen in het geheugen van dit scherm: de server bewaart het
   * wachtwoord als hash en er is geen tweede kans om het op te halen.
   */
  readonly uitgereikt = signal<{
    eenheidId: string;
    email: string;
    wachtwoord: string;
  } | null>(null);

  constructor() {
    void this.laad();
  }

  async laad(): Promise<void> {
    this.bezig.set(true);
    try {
      // Welke VvE hier bewerkt wordt, staat in de query (`?vve=`) — het
      // startscherm geeft hem mee vanaf de aangeklikte kaart. Zonder parameter
      // (iemand die de URL rechtstreeks intypt) valt het terug op de eerste
      // VvE uit het profiel; bij één VvE is dat hetzelfde.
      const gekozen = this.#route.snapshot.queryParamMap.get('vve');
      if (gekozen === null) {
        await this.#auth.kiesActieveVveVanEerste();
      } else {
        await this.#auth.kiesActieveVve(gekozen);
      }
      this.overzicht.set(await this.#service.lijst());
    } catch (e) {
      this.fout.set(e as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }

  /**
   * Opent het formulier en haalt meteen een wachtwoordvoorstel op. Het voorstel
   * komt van de server: de CSPRNG en de sterkte-eisen staan daar (F12), en een
   * wachtwoord dat de browser verzint zou langs die eisen heen kunnen.
   */
  async openFormulier(eenheidId: string): Promise<void> {
    this.eigenaarModel.set(leegEigenaar());
    this.uitgereikt.set(null);
    this.fout.set(null);
    this.openEenheidId.set(eenheidId);
    await this.nieuwVoorstel();
  }

  sluitFormulier(): void {
    this.openEenheidId.set(null);
    this.eigenaarModel.set(leegEigenaar());
  }

  async nieuwVoorstel(): Promise<void> {
    try {
      const { wachtwoord } = await this.#service.wachtwoordVoorstel();
      this.zetEigenaarVeld('wachtwoord', wachtwoord);
    } catch (e) {
      this.fout.set(e as ApiFout);
    }
  }

  async geefToegang(eenheidId: string): Promise<void> {
    const velden = this.eigenaarModel();
    if (velden.email.trim() === '' || velden.achternaam.trim() === '') return;
    this.bezig.set(true);
    this.fout.set(null);
    try {
      await this.#service.maakEigenaarAccount(eenheidId, velden);
      // Eerst vasthouden, dán het formulier leegmaken: hierna is het
      // wachtwoord nergens meer op te vragen.
      this.uitgereikt.set({ eenheidId, email: velden.email, wachtwoord: velden.wachtwoord });
      this.openEenheidId.set(null);
      this.eigenaarModel.set(leegEigenaar());
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
