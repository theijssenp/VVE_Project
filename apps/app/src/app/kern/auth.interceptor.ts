/**
 * HTTP-interceptor — F11 (spec §7.5, §7.6).
 *
 * Drie taken:
 *   1. het access-token als `Authorization: Bearer` meesturen;
 *   2. bij een 401 één keer verversen en het verzoek herhalen;
 *   3. fouten vertalen naar de uniforme {@link ApiFout}-vorm.
 *
 * Twee dingen die hier expres níet gebeuren. De auth-endpoints zelf worden
 * overgeslagen: een 401 op `/auth/verversen` betekent dat de sessie voorbij is,
 * en daar nog eens verversen levert een oneindige lus op. En er wordt maar één
 * keer herhaald — een tweede 401 na een verse token is geen tokenprobleem maar
 * een rechtenprobleem, en dat los je niet op door harder te proberen.
 */

import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { type Observable, catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService } from './auth.service.js';
import { magVerversen } from './verversing.js';
import { naarApiFout } from './fout.js';

function metToken(verzoek: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
  if (token === null) return verzoek;
  return verzoek.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

export const authInterceptor: HttpInterceptorFn = (
  verzoek: HttpRequest<unknown>,
  volgende: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const auth = inject(AuthService);

  const uitvoeren = (token: string | null): Observable<HttpEvent<unknown>> =>
    volgende(metToken(verzoek, token));

  return uitvoeren(auth.accessToken()).pipe(
    catchError((fout: unknown) => {
      if (!(fout instanceof HttpErrorResponse)) {
        return throwError(() => fout);
      }
      const herhaalbaar = fout.status === 401 && magVerversen(verzoek.url);
      if (!herhaalbaar) {
        return throwError(() => naarApiFout(fout.status, fout.error));
      }
      // De poort zit in AuthService, niet hier: het herstel bij opstarten
      // ververst langs hetzelfde slot, en twee sloten is geen slot (§7.6).
      return from(auth.verversEenmalig()).pipe(
        switchMap((nieuw) => {
          if (nieuw === null) {
            // Verversen lukte niet: de sessie is echt voorbij.
            return throwError(() => naarApiFout(401, fout.error));
          }
          return uitvoeren(nieuw).pipe(
            catchError((tweede: unknown) =>
              throwError(() =>
                tweede instanceof HttpErrorResponse
                  ? naarApiFout(tweede.status, tweede.error)
                  : tweede,
              ),
            ),
          );
        }),
      );
    }),
  );
};
