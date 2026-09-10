/** Routering — F11 (spec §7.8: portaal en beheer als twee schillen). */
import type { Routes } from '@angular/router';

import { vereistSessie } from './kern/auth.guard.js';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'portaal' },
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
    path: 'beheer',
    canActivate: [vereistSessie],
    loadComponent: () => import('./beheer/beheer.page.js').then((m) => m.BeheerPage),
  },
  { path: '**', redirectTo: 'portaal' },
];
