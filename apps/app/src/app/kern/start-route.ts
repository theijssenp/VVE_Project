/**
 * Welk startscherm hoort bij wie — F11/V01 (spec §9: twee schillen).
 *
 * Eén plek waar dit wordt beslist, en met opzet een pure functie zonder
 * Angular eromheen: de keuze is een regel, geen schermdetail, en hij hoort
 * getoetst te kunnen worden zonder router of browser.
 *
 * De volgorde is niet willekeurig. De applicatiebeheerder gaat naar de
 * beheeromgeving; hij is de enige die VvE's mag opvoeren. Wie een lopende
 * beheerrol in een VvE heeft, komt in het overzicht van díé VvE — niet in het
 * opvoerscherm, waar hij niets mag en de server hem met 403 zou wegsturen. Al
 * het overige is een eigenaar, en die hoort in het portaal.
 *
 * Dit stuurt alleen de navigatie. De afscherming zelf staat op de endpoints
 * (`#eisApplicatiebeheerder`) en straks in RLS; een client die deze functie
 * negeert, komt daarmee nergens.
 */
import type { Profiel } from './auth.service.js';

export const START_INLOGGEN = '/inloggen';
export const START_BEHEER = '/beheer';
export const START_VVE = '/vve';
export const START_PORTAAL = '/portaal';

export function startRoute(profiel: Profiel | null): string {
  if (profiel === null) return START_INLOGGEN;
  if (profiel.isApplicatiebeheerder) return START_BEHEER;
  if (profiel.vves.length > 0) return START_VVE;
  return START_PORTAAL;
}
