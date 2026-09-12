/**
 * Clientkant van het eigenaarsportaal — blok V07 (spec M14 · AC14.1–14.3).
 *
 * Alleen HTTP; het scherm houdt de toestand vast. De interceptor plakt het
 * access-token erop en vertaalt fouten naar {@link ApiFout}.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASIS } from '../kern/tokens.js';

export interface PortaalEenheid {
  readonly eenheidId: string;
  readonly code: string;
  readonly type: string;
  readonly oppervlakteM2: number | null;
  readonly breukdeelTeller: number;
  readonly breukdeelNoemer: number;
  readonly aandeelPromille: number;
  readonly isPrimairContact: boolean;
  readonly sinds: string;
  readonly openstaandCenten: number;
  readonly oudsteVervaldatum: string | null;
  readonly creditSaldoCenten: number;
}

export interface PortaalBetaling {
  readonly id: string;
  readonly datum: string;
  readonly bedragCent: number;
  readonly bron: string;
  readonly omschrijving: string | null;
  readonly gekoppeldCenten: number;
}

export interface PortaalMededeling {
  readonly id: string;
  readonly titel: string;
  readonly inhoud: string;
  readonly doelgroep: string;
  readonly gepubliceerdOp: string;
}

export interface PortaalOverzicht {
  readonly vveId: string;
  readonly eenheden: readonly PortaalEenheid[];
  readonly betalingen: readonly PortaalBetaling[];
  readonly mededelingen: readonly PortaalMededeling[];
}

export interface PortaalGegevens {
  readonly persoonId: string;
  readonly email: string;
  readonly voornaam: string | null;
  readonly tussenvoegsel: string | null;
  readonly achternaam: string;
  readonly telefoon: string | null;
  readonly corrStraat: string | null;
  readonly corrHuisnummer: string | null;
  readonly corrPostcode: string | null;
  readonly corrPlaats: string | null;
  readonly communicatieWijze: string;
}

export interface GegevensWijziging {
  voornaam?: string;
  tussenvoegsel?: string;
  achternaam?: string;
  telefoon?: string;
  corrStraat?: string;
  corrHuisnummer?: string;
  corrPostcode?: string;
  corrPlaats?: string;
  communicatieWijze?: string;
}

@Injectable({ providedIn: 'root' })
export class PortaalService {
  readonly #http = inject(HttpClient);
  readonly #basis = inject(API_BASIS);

  /** M14-startscherm in één call. */
  overzicht(): Promise<PortaalOverzicht> {
    return firstValueFrom(this.#http.get<PortaalOverzicht>(`${this.#basis}/portaal`));
  }

  gegevens(): Promise<PortaalGegevens> {
    return firstValueFrom(this.#http.get<PortaalGegevens>(`${this.#basis}/portaal/gegevens`));
  }

  wijzigGegevens(wijziging: GegevensWijziging): Promise<PortaalGegevens> {
    return firstValueFrom(
      this.#http.patch<PortaalGegevens>(`${this.#basis}/portaal/gegevens`, wijziging),
    );
  }
}
