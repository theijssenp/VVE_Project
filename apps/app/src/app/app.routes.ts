/** Routering — F11 (spec §7.8: portaal en beheer als twee schillen). */
import type { Routes } from '@angular/router';

import {
  naarStartscherm,
  vereistApplicatiebeheerder,
  vereistSessie,
  vereistVveRol,
} from './kern/auth.guard.js';

export const routes: Routes = [
  // Geen vaste redirect: waar iemand hoort te beginnen hangt af van zijn rol
  // (applicatiebeheerder, VvE-beheerder of eigenaar). `naarStartscherm` beslist.
  { path: '', pathMatch: 'full', canActivate: [naarStartscherm], children: [] },
  {
    path: 'inloggen',
    loadComponent: () => import('./inloggen/inloggen.page.js').then((m) => m.InloggenPage),
  },
  {
    path: 'mfa',
    loadComponent: () => import('./inloggen/mfa.page.js').then((m) => m.MfaPage),
  },
  {
    path: 'portaal',
    canActivate: [vereistSessie],
    loadComponent: () => import('./portaal/portaal.page.js').then((m) => m.PortaalPage),
  },
  {
    path: 'vve',
    canActivate: [vereistSessie, vereistVveRol],
    loadComponent: () => import('./vve/vve-overzicht.page.js').then((m) => m.VveOverzichtPage),
  },
  {
    // Wooneenheden van de actieve VvE (V02): lijst met breukdelen en
    // eigenaren plus de AC2.3-somcontrole en een invoerformulier.
    path: 'vve/eenheden',
    canActivate: [vereistSessie, vereistVveRol],
    loadComponent: () => import('./vve/eenheden.page.js').then((m) => m.EenhedenPage),
  },
  {
    // Alleen de applicatiebeheerder: hier worden VvE's opgevoerd (AC1.1) en
    // beheerderswachtwoorden uitgereikt (AC1.3).
    path: 'beheer',
    canActivate: [vereistSessie, vereistApplicatiebeheerder],
    loadComponent: () => import('./beheer/beheer.page.js').then((m) => m.BeheerPage),
  },
  { path: '**', redirectTo: '' },
];
