/**
 * Clientkant van het VvE-beheer — blok V01.
 *
 * Alleen HTTP; het scherm houdt de toestand vast. De interceptor plakt het
 * access-token erop en vertaalt fouten naar {@link ApiFout}, dus hier staat
 * geen enkele foutafhandeling.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASIS } from '../kern/tokens.js';

export interface Beheerder {
  readonly persoonId: string;
  readonly email: string;
  readonly naam: string;
  readonly laatsteLoginOp: string | null;
  readonly actief: boolean;
  readonly wachtwoordWijzigenVerplicht: boolean;
}

export interface Vve {
  readonly id: string;
  readonly naam: string;
  readonly plaats: string | null;
  readonly status: 'actief' | 'gearchiveerd';
  readonly boekjaarStartmaand: number;
  readonly aantalEenheden: number;
  readonly beheerders: readonly Beheerder[];
}

export interface VveInvoer {
  naam: string;
  boekjaarStartmaand: number;
  plaats?: string;
  straat?: string;
  huisnummer?: string;
  postcode?: string;
  kvkNummer?: string;
  splitsingsdatum?: string;
  modelreglement?: string;
  breukdeelNoemer?: number;
}

export interface BeheerderInvoer {
  email: string;
  voornaam?: string;
  achternaam: string;
  wachtwoord: string;
}

@Injectable({ providedIn: 'root' })
export class VveBeheerService {
  readonly #http = inject(HttpClient);
  readonly #basis = inject(API_BASIS);

  lijst(): Promise<Vve[]> {
    return firstValueFrom(this.#http.get<Vve[]>(`${this.#basis}/vve`));
  }

  keuzes(): Promise<{ modelreglementen: string[] }> {
    return firstValueFrom(
      this.#http.get<{ modelreglementen: string[] }>(`${this.#basis}/vve/keuzes`),
    );
  }

  /** Vraagt de server om een wachtwoord uit zijn CSPRNG (§7.6, blok F12). */
  async wachtwoordVoorstel(): Promise<string> {
    const uit = await firstValueFrom(
      this.#http.get<{ wachtwoord: string }>(`${this.#basis}/vve/wachtwoord-voorstel`),
    );
    return uit.wachtwoord;
  }

  maak(vve: VveInvoer, beheerder: BeheerderInvoer): Promise<{ vveId: string; persoonId: string }> {
    return firstValueFrom(
      this.#http.post<{ vveId: string; persoonId: string }>(`${this.#basis}/vve`, {
        vve,
        beheerder,
      }),
    );
  }

  voegBeheerderToe(vveId: string, beheerder: BeheerderInvoer): Promise<{ persoonId: string }> {
    return firstValueFrom(
      this.#http.post<{ persoonId: string }>(`${this.#basis}/vve/${vveId}/beheerder`, beheerder),
    );
  }

  zetStatus(vveId: string, status: 'actief' | 'gearchiveerd'): Promise<unknown> {
    return firstValueFrom(this.#http.post(`${this.#basis}/vve/${vveId}/status`, { status }));
  }

  zetWachtwoord(
    vveId: string,
    persoonId: string,
    wachtwoord: string,
  ): Promise<{ sessiesIngetrokken: number }> {
    return firstValueFrom(
      this.#http.post<{ sessiesIngetrokken: number }>(
        `${this.#basis}/vve/${vveId}/beheerder/${persoonId}/wachtwoord`,
        { wachtwoord },
      ),
    );
  }
}
