/** Routebewaking — F11. Zonder sessie naar het inlogscherm; met openstaande MFA daarheen. */
import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';

import { AuthService } from './auth.service.js';

export const vereistSessie: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.ingelogd()) return router.createUrlTree(['/inloggen']);
  if (auth.mfaVereist()) return router.createUrlTree(['/mfa']);
  return true;
};
