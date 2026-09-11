/** Routebewaking — F11. Zonder sessie naar het inlogscherm; met openstaande MFA daarheen. */
import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';

import { AuthService } from './auth.service.js';
import { startRoute } from './start-route.js';

export const vereistSessie: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.ingelogd()) return router.createUrlTree(['/inloggen']);
  if (auth.mfaVereist()) return router.createUrlTree(['/mfa']);
  return true;
};

/**
 * Zorgt dat het profiel geladen is voordat een scherm erop bouwt. Bij een
 * mislukking géén doorgang: zonder te weten wie iemand is, valt niet te zeggen
 * welk scherm bij hem hoort.
 */
async function metProfiel(auth: AuthService): Promise<boolean> {
  if (auth.profiel() !== null) return true;
  try {
    await auth.laadProfiel();
    return true;
  } catch {
    return false;
  }
}

/**
 * De beheeromgeving is alleen voor de applicatiebeheerder: daar worden VvE's
 * opgevoerd en beheerderswachtwoorden uitgereikt. Een VvE-beheerder die hier
 * komt, wordt naar zijn eigen startscherm gestuurd in plaats van naar een
 * formulier dat de server toch met 403 zou weigeren.
 */
export const vereistApplicatiebeheerder: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!(await metProfiel(auth))) return router.createUrlTree(['/inloggen']);
  if (auth.profiel()?.isApplicatiebeheerder === true) return true;
  return router.createUrlTree([startRoute(auth.profiel())]);
};

/**
 * Het VvE-overzicht is voor wie werkelijk een lopende rol in een VvE heeft.
 * Zonder rol is er niets te tonen, dus dan naar het eigen startscherm.
 */
export const vereistVveRol: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!(await metProfiel(auth))) return router.createUrlTree(['/inloggen']);
  const profiel = auth.profiel();
  if (profiel !== null && profiel.vves.length > 0) return true;
  return router.createUrlTree([startRoute(profiel)]);
};

/**
 * De wortelroute: stuur iedereen naar het scherm dat bij zijn rol hoort, in
 * plaats van iedereen naar het portaal en dan maar zien.
 */
export const naarStartscherm: CanActivateFn = async (): Promise<UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.ingelogd()) return router.createUrlTree(['/inloggen']);
  if (auth.mfaVereist()) return router.createUrlTree(['/mfa']);
  if (!(await metProfiel(auth))) return router.createUrlTree(['/inloggen']);
  return router.createUrlTree([startRoute(auth.profiel())]);
};
