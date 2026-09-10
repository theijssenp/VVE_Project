/**
 * Uniforme foutafhandeling — F11 (spec §7.5, §8.2).
 *
 * De API antwoordt met `{ code, melding, referentie }` en toont in productie
 * geen stacktraces. De client vertaalt dat naar één vorm, zodat elk scherm
 * dezelfde melding kan tonen, en verzint nooit zelf detail dat de server niet
 * gaf: een foutpagina die te veel weet, vertelt een aanvaller te veel.
 */

export interface ApiFout {
  /** Machineleesbare code, of `onbekend` als de server er geen gaf. */
  readonly code: string;
  /** Tekst die aan de gebruiker getoond mag worden. */
  readonly melding: string;
  /** Verwijzing naar het serverlog; toon hem, zodat support hem kan opzoeken. */
  readonly referentie: string | null;
  readonly status: number;
}

const ALGEMEEN = 'Er ging iets mis. Probeer het opnieuw.';

/** Meldingen per statuscode; bewust kort en zonder aanwijzingen over de oorzaak. */
const PER_STATUS: Record<number, string> = {
  0: 'Geen verbinding met de server.',
  400: 'De ingevoerde gegevens kloppen niet.',
  401: 'U bent niet (meer) ingelogd.',
  403: 'U heeft geen toegang tot dit onderdeel.',
  404: 'Niet gevonden.',
  429: 'Te veel pogingen. Wacht even en probeer het opnieuw.',
  500: ALGEMEEN,
  503: 'De server is tijdelijk niet bereikbaar.',
};

function isRecord(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null;
}

/**
 * Vertaalt een HTTP-fout naar {@link ApiFout}. `lichaam` is wat de server
 * terugstuurde; ontbreekt daarin een melding, dan valt hij terug op de tekst bij
 * de statuscode.
 */
export function naarApiFout(status: number, lichaam: unknown): ApiFout {
  const veld = (naam: string): string | null => {
    if (!isRecord(lichaam)) return null;
    const waarde = lichaam[naam];
    return typeof waarde === 'string' && waarde !== '' ? waarde : null;
  };
  return {
    code: veld('code') ?? 'onbekend',
    melding: veld('melding') ?? PER_STATUS[status] ?? ALGEMEEN,
    referentie: veld('referentie'),
    status,
  };
}

/** Een 401 betekent: sessie weg. Alleen dán logt de client de gebruiker uit. */
export function isSessieVerlopen(fout: ApiFout): boolean {
  return fout.status === 401;
}
