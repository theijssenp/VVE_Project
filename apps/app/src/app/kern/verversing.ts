/**
 * Enkelvoudige tokenverversing — F11 (spec §7.6).
 *
 * Bij het herladen van een scherm lopen er vaak meerdere verzoeken tegelijk. Als
 * die allemaal een 401 krijgen en allemaal zelfstandig gaan verversen, wisselt
 * elk van hen het refresh-token in. Het tweede gebruik van een al ingewisseld
 * token is precies wat de server als **diefstal** aanmerkt: die trekt dan de
 * hele tokenfamilie in en logt de gebruiker overal uit (§7.6).
 *
 * Deze helper zorgt dat er hoogstens één verversing tegelijk loopt; de overige
 * verzoeken wachten op dezelfde belofte. Losstaand van Angular gehouden, zodat
 * dit gedrag zonder browser te testen is.
 */
export class EnkeleVerversing {
  #lopend: Promise<string | null> | null = null;

  /**
   * Voert `ververs` uit, of sluit aan bij een verversing die al loopt.
   * De belofte wordt vrijgegeven zodra ze klaar is, zodat een volgende 401
   * opnieuw mag proberen.
   */
  async voerUit(ververs: () => Promise<string | null>): Promise<string | null> {
    const lopend = this.#lopend;
    if (lopend !== null) return lopend;

    const belofte = ververs().finally(() => {
      this.#lopend = null;
    });
    this.#lopend = belofte;
    return belofte;
  }

  get loopt(): boolean {
    return this.#lopend !== null;
  }
}

/**
 * Endpoints die nooit een verversronde mogen uitlokken.
 *
 * Een 401 op `/auth/verversen` betekent dat de sessie voorbij is; daar opnieuw
 * verversen levert een oneindige lus op. Bij `/auth/inloggen` betekent een 401
 * simpelweg verkeerde inloggegevens.
 */
export const ZONDER_VERVERSING = [
  '/auth/inloggen',
  '/auth/verversen',
  '/auth/uitloggen',
  '/auth/mfa',
] as const;

/** Mag een 401 op deze URL een verversing uitlokken? */
export function magVerversen(url: string): boolean {
  return !ZONDER_VERVERSING.some((pad) => url.includes(pad));
}
