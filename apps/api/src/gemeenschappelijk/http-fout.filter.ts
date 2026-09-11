/**
 * Uniforme foutvorm — API-breed (spec §8.2).
 *
 * De client verwacht `{ code, melding, referentie }` (zie
 * `apps/app/src/app/kern/fout.ts`); Nest stuurt uit zichzelf
 * `{ statusCode, error, message }`. Zonder deze filter matcht er niets en valt
 * élk scherm terug op de generieke tekst bij de statuscode — waardoor een fout
 * wachtwoord zich voordoet als een verlopen sessie.
 *
 * Twee regels die hier gelden:
 *
 *   1. **4xx mag de tekst van de server tonen.** Die is door ons geschreven en
 *      bewust nietszeggend waar dat hoort ("E-mailadres of wachtwoord onjuist"
 *      zegt niet welk van de twee fout was).
 *   2. **5xx nooit.** Daar gaat alleen een referentie naar de client; de
 *      werkelijke fout staat in het serverlog onder diezelfde referentie. Een
 *      stacktrace in het antwoord vertelt een aanvaller hoe de binnenkant eruit
 *      ziet.
 *
 * De referentie komt uit `randomUUID()` en niet uit `Math.random()` — dat laatste
 * is buiten tests sowieso verboden (blok F12).
 */
import { randomUUID } from 'node:crypto';

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

/** Machineleesbare code per statuscode; de client schakelt hierop, niet op tekst. */
const CODE_PER_STATUS: Record<number, string> = {
  400: 'ongeldige_invoer',
  401: 'niet_geauthenticeerd',
  403: 'geen_toegang',
  404: 'niet_gevonden',
  409: 'conflict',
  422: 'ongeldige_invoer',
  429: 'te_veel_pogingen',
};

const ALGEMEEN = 'Er ging iets mis. Probeer het opnieuw.';

/** Vanaf deze status is de fout van ons, niet van de aanroeper. */
const EERSTE_SERVERFOUT = 500;

/**
 * Haalt de toonbare tekst uit wat Nest in de exception stopte. `message` is
 * daar een string óf een array (bij een validatiefout met meerdere velden).
 */
function meldingUit(lichaam: unknown, terugval: string): string {
  if (typeof lichaam === 'string') return lichaam;
  if (typeof lichaam !== 'object' || lichaam === null) return terugval;
  const bericht = (lichaam as { message?: unknown }).message;
  if (typeof bericht === 'string' && bericht !== '') return bericht;
  if (Array.isArray(bericht)) {
    const regels = bericht.filter((r): r is string => typeof r === 'string');
    if (regels.length > 0) return regels.join(' ');
  }
  return terugval;
}

@Catch()
export class HttpFoutFilter implements ExceptionFilter {
  readonly #log = new Logger('HttpFout');

  catch(fout: unknown, host: ArgumentsHost): void {
    const antwoord = host.switchToHttp().getResponse<Response>();
    const referentie = randomUUID();

    if (fout instanceof HttpException) {
      const status = fout.getStatus();
      if (status < EERSTE_SERVERFOUT) {
        antwoord.status(status).json({
          code: CODE_PER_STATUS[status] ?? 'fout',
          melding: meldingUit(fout.getResponse(), ALGEMEEN),
          referentie,
        });
        return;
      }
    }

    // Alles vanaf 500: de oorzaak gaat naar het log, niet naar de client.
    this.#log.error(
      `${referentie} — ${fout instanceof Error ? (fout.stack ?? fout.message) : String(fout)}`,
    );
    antwoord.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'serverfout',
      melding: ALGEMEEN,
      referentie,
    });
  }
}
