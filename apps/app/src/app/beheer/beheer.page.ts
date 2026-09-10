import { Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

/**
 * Beheeromgeving. Bewust alleen op web bereikbaar (spec §7.8): de handelingen
 * die hier komen — incasso, IBAN-wijziging, gebruikersbeheer — worden door de
 * server geweigerd op een token met `client: 'native'`.
 */
@Component({
  selector: 'vve-beheer',
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header
      ><ion-toolbar><ion-title>Beheer</ion-title></ion-toolbar></ion-header
    >
    <ion-content class="ion-padding">
      <p>De beheerschermen volgen vanaf fase 1 (blok V01).</p>
    </ion-content>
  `,
})
export class BeheerPage {}
