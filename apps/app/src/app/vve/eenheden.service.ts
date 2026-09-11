/**
 * Clientkant van de wooneenheden — blok V02.
 *
 * Alleen HTTP; het scherm houdt de toestand vast. De interceptor plakt het
 * access-token erop en vertaalt fouten naar {@link ApiFout}, dus hier staat
 * geen enkele foutafhandeling.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASIS } from '../kern/tokens.js';

export interface Eigenaar {
  readonly persoonId: string;
  readonly naam: string;
  readonly aandeelPromille: number;
  readonly isPrimairContact: boolean;
}

export interface Eenheid {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly gebouwNaam: string | null;
  readonly adres: string | null;
  readonly bouwlaag: number | null;
  readonly oppervlakteM2: number | null;
  readonly breukdeelTeller: number;
  readonly breukdeelNoemer: number;
  readonly stemmen: number;
  readonly kadastraleAanduiding: string | null;
  readonly actiefVanaf: string | null;
  readonly actiefTot: string | null;
  readonly eigenaren: readonly Eigenaar[];
}

export interface Gebouw {
  readonly id: string;
  readonly naam: string;
  readonly adres: string | null;
}

export interface EenhedenOverzicht {
  readonly eenheden: readonly Eenheid[];
  readonly gebouwen: readonly Gebouw[];
  /** AC2.3: som van de tellers, de noemer van de VvE en het verschil. */
  readonly somTeller: number;
  readonly noemer: number;
  readonly verschil: number;
}

export interface EenheidInvoer {
  code: string;
  type?: string;
  gebouwNaam?: string;
  straat?: string;
  huisnummer?: string;
  huisnummerToevoeging?: string;
  postcode?: string;
  plaats?: string;
  bouwlaag?: number;
  oppervlakteM2?: number;
  breukdeelTeller?: number;
  breukdeelNoemer?: number;
  stemmen?: number;
  kadastraleAanduiding?: string;
}

@Injectable({ providedIn: 'root' })
export class EenhedenService {
  readonly #http = inject(HttpClient);
  readonly #basis = inject(API_BASIS);

  lijst(): Promise<EenhedenOverzicht> {
    return firstValueFrom(this.#http.get<EenhedenOverzicht>(`${this.#basis}/vve-mij`));
  }

  maak(eenheid: EenheidInvoer): Promise<{ eenheidId: string }> {
    return firstValueFrom(
      this.#http.post<{ eenheidId: string }>(`${this.#basis}/vve-mij`, { eenheid }),
    );
  }
}
