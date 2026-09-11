/**
 * Beheeromgeving voor de applicatiebeheerder — blok V01 (M1 · AC1.1–1.5).
 *
 * Bewust alleen op web bereikbaar (spec §7.8): de handelingen die hier komen —
 * incasso, IBAN-wijziging, gebruikersbeheer — worden door de server geweigerd
 * op een token met `client: 'native'`.
 *
 * **Wachtwoorden.** Zolang SMTP niet bruikbaar is, typt de applicatiebeheerder
 * het wachtwoord hier zelf in (of laat hij er een genereren) en geeft hij het
 * buiten de applicatie om door. Het wachtwoord is daarna niet meer op te
 * vragen — er staat alleen een argon2id-hash in de database. Daarom blijft het
 * na opslaan één keer zichtbaar staan, met de waarschuwing erbij.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  IonBadge,
  IonButton,
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
import { VveBeheerService, type BeheerderInvoer, type Vve, type VveInvoer } from './vve.service.js';

/** Lege formulierwaarden; ook gebruikt om na opslaan te resetten. */
function leegVve(): VveInvoer {
  return { naam: '', boekjaarStartmaand: 1 };
}
function leegBeheerder(): BeheerderInvoer {
  return { email: '', achternaam: '', wachtwoord: '' };
}

@Component({
  selector: 'vve-beheer',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonBadge,
    IonButton,
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
      ><ion-toolbar><ion-title>Beheer</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      @if (fout(); as f) {
        <ion-text color="danger"
          ><p>{{ f.melding }}</p></ion-text
        >
        @if (f.referentie) {
          <ion-note>Referentie: {{ f.referentie }}</ion-note>
        }
      }

      @if (uitgereikt(); as u) {
        <div class="uitgifte">
          <h3>Toegang aangemaakt — noteer dit nu</h3>
          <p>
            Dit wachtwoord is nergens op te vragen. Geef het door aan
            <strong>{{ u.email }}</strong> en sluit dit blok daarna.
          </p>
          <p class="geheim">{{ u.wachtwoord }}</p>
          <ion-button size="small" (click)="kopieer(u.wachtwoord)">Kopieer</ion-button>
          <ion-button size="small" fill="clear" (click)="uitgereikt.set(null)">Sluiten</ion-button>
        </div>
      }

      <!--
        De applicatiebeheerder draagt de zwaarste rechten (gebruikersrollen,
        IBAN, incasso) en komt nooit op het portaal; zonder deze ingang zou hij
        zijn tweede factor nergens kunnen instellen.
      -->
      <ion-button size="small" fill="outline" routerLink="/beveiliging">Beveiliging</ion-button>

      <h2>Nieuwe VvE</h2>
      <form (ngSubmit)="maakVve()">
        <ion-input
          label="Naam van de VvE"
          labelPlacement="stacked"
          fill="outline"
          name="naam"
          [(ngModel)]="vve.naam"
        ></ion-input>
        <ion-item>
          <ion-select
            label="Eerste maand van het boekjaar"
            labelPlacement="stacked"
            name="boekjaarStartmaand"
            [(ngModel)]="vve.boekjaarStartmaand"
          >
            @for (m of maanden; track m.nummer) {
              <ion-select-option [value]="m.nummer">{{ m.naam }}</ion-select-option>
            }
          </ion-select>
        </ion-item>
        <ion-input
          label="Plaats"
          labelPlacement="stacked"
          fill="outline"
          name="plaats"
          [(ngModel)]="vve.plaats"
        ></ion-input>
        <ion-input
          label="Straat"
          labelPlacement="stacked"
          fill="outline"
          name="straat"
          [(ngModel)]="vve.straat"
        ></ion-input>
        <ion-input
          label="Huisnummer(s)"
          labelPlacement="stacked"
          fill="outline"
          name="huisnummer"
          [(ngModel)]="vve.huisnummer"
        ></ion-input>
        <ion-input
          label="Postcode"
          labelPlacement="stacked"
          fill="outline"
          name="postcode"
          [(ngModel)]="vve.postcode"
        ></ion-input>
        <ion-input
          label="KvK-nummer"
          labelPlacement="stacked"
          fill="outline"
          name="kvkNummer"
          [(ngModel)]="vve.kvkNummer"
        ></ion-input>
        <ion-input
          label="Datum splitsingsakte"
          labelPlacement="stacked"
          fill="outline"
          type="date"
          name="splitsingsdatum"
          [(ngModel)]="vve.splitsingsdatum"
        ></ion-input>
        <ion-item>
          <ion-select
            label="Modelreglement"
            labelPlacement="stacked"
            name="modelreglement"
            [(ngModel)]="vve.modelreglement"
          >
            @for (r of modelreglementen(); track r) {
              <ion-select-option [value]="r">{{ r }}</ion-select-option>
            }
          </ion-select>
        </ion-item>

        <h3>Beheerder van deze VvE</h3>
        <ion-note>
          Verplicht: een VvE zonder beheerder kan niemand gebruiken. Je typt het wachtwoord zelf in
          en geeft het buiten de applicatie om door.
        </ion-note>
        <ion-input
          label="Voornaam"
          labelPlacement="stacked"
          fill="outline"
          name="bhVoornaam"
          [(ngModel)]="beheerder.voornaam"
        ></ion-input>
        <ion-input
          label="Achternaam"
          labelPlacement="stacked"
          fill="outline"
          name="bhAchternaam"
          [(ngModel)]="beheerder.achternaam"
        ></ion-input>
        <ion-input
          label="E-mailadres"
          labelPlacement="stacked"
          fill="outline"
          type="email"
          name="bhEmail"
          [(ngModel)]="beheerder.email"
        ></ion-input>
        <ion-input
          label="Wachtwoord (minimaal 12 tekens)"
          labelPlacement="stacked"
          fill="outline"
          type="text"
          name="bhWachtwoord"
          [(ngModel)]="beheerder.wachtwoord"
        ></ion-input>
        <ion-button size="small" fill="outline" type="button" (click)="stelWachtwoordVoor()">
          Genereer wachtwoord
        </ion-button>

        <button type="submit" tabindex="-1" aria-hidden="true" style="display: none"></button>
        <ion-button expand="block" type="submit" [disabled]="bezig()">VvE aanmaken</ion-button>
      </form>

      <h2>Bestaande VvE's</h2>
      <ion-list>
        @for (v of vves(); track v.id) {
          <ion-item>
            <ion-label>
              <h3>{{ v.naam }}</h3>
              <p>
                {{ v.plaats ?? 'plaats onbekend' }} · {{ v.aantalEenheden }} eenheden · boekjaar
                start in maand {{ v.boekjaarStartmaand }}
              </p>
              @for (b of v.beheerders; track b.persoonId) {
                <p>
                  Beheerder: {{ b.naam }} ({{ b.email }}) — laatste login:
                  {{ b.laatsteLoginOp ?? 'nog nooit' }}
                  <ion-button
                    size="small"
                    fill="clear"
                    (click)="nieuwWachtwoord(v.id, b.persoonId, b.email)"
                  >
                    Nieuw wachtwoord
                  </ion-button>
                </p>
              } @empty {
                <p>
                  <ion-text color="danger">Geen beheerder — dit hoort niet te kunnen.</ion-text>
                </p>
              }
            </ion-label>
            <ion-badge slot="end" [color]="v.status === 'actief' ? 'success' : 'medium'">
              {{ v.status }}
            </ion-badge>
            <ion-button slot="end" size="small" fill="outline" (click)="wisselStatus(v)">
              {{ v.status === 'actief' ? 'Archiveren' : 'Heractiveren' }}
            </ion-button>
          </ion-item>
        } @empty {
          <ion-item><ion-label>Nog geen VvE's aangemaakt.</ion-label></ion-item>
        }
      </ion-list>
    </ion-content>
  `,
  styles: [
    `
      .uitgifte {
        border: 2px solid var(--ion-color-warning, #e0ac08);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
      }
      .geheim {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 1.2rem;
        user-select: all;
        word-break: break-all;
      }
    `,
  ],
})
export class BeheerPage {
  readonly #api = inject(VveBeheerService);

  readonly maanden = [
    { nummer: 1, naam: 'januari' },
    { nummer: 2, naam: 'februari' },
    { nummer: 3, naam: 'maart' },
    { nummer: 4, naam: 'april' },
    { nummer: 5, naam: 'mei' },
    { nummer: 6, naam: 'juni' },
    { nummer: 7, naam: 'juli' },
    { nummer: 8, naam: 'augustus' },
    { nummer: 9, naam: 'september' },
    { nummer: 10, naam: 'oktober' },
    { nummer: 11, naam: 'november' },
    { nummer: 12, naam: 'december' },
  ];

  vve: VveInvoer = leegVve();
  beheerder: BeheerderInvoer = leegBeheerder();

  readonly vves = signal<Vve[]>([]);
  readonly modelreglementen = signal<string[]>([]);
  readonly bezig = signal(false);
  readonly fout = signal<ApiFout | null>(null);
  /** Het zojuist uitgereikte wachtwoord; alleen in beeld, nooit opgeslagen. */
  readonly uitgereikt = signal<{ email: string; wachtwoord: string } | null>(null);

  constructor() {
    void this.#laad();
  }

  async #laad(): Promise<void> {
    try {
      this.vves.set(await this.#api.lijst());
      this.modelreglementen.set((await this.#api.keuzes()).modelreglementen);
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    }
  }

  async stelWachtwoordVoor(): Promise<void> {
    try {
      this.beheerder.wachtwoord = await this.#api.wachtwoordVoorstel();
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    }
  }

  async maakVve(): Promise<void> {
    this.bezig.set(true);
    this.fout.set(null);
    try {
      const email = this.beheerder.email;
      const wachtwoord = this.beheerder.wachtwoord;
      await this.#api.maak(this.vve, this.beheerder);
      this.uitgereikt.set({ email, wachtwoord });
      this.vve = leegVve();
      this.beheerder = leegBeheerder();
      await this.#laad();
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    } finally {
      this.bezig.set(false);
    }
  }

  async nieuwWachtwoord(vveId: string, persoonId: string, email: string): Promise<void> {
    this.fout.set(null);
    try {
      const wachtwoord = await this.#api.wachtwoordVoorstel();
      await this.#api.zetWachtwoord(vveId, persoonId, wachtwoord);
      this.uitgereikt.set({ email, wachtwoord });
      await this.#laad();
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    }
  }

  async wisselStatus(v: Vve): Promise<void> {
    this.fout.set(null);
    try {
      await this.#api.zetStatus(v.id, v.status === 'actief' ? 'gearchiveerd' : 'actief');
      await this.#laad();
    } catch (fout: unknown) {
      this.fout.set(fout as ApiFout);
    }
  }

  async kopieer(tekst: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(tekst);
    } catch {
      // Kopiëren mag mislukken (geen toestemming); de tekst staat in beeld.
    }
  }
}
