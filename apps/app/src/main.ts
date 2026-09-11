/**
 * Opstartpunt van de Ionic-schil — F11.
 *
 * PWA eerst (spec §7.8): dit draait als gewone webapp; de Capacitor-build komt
 * in blok N01 en vervangt dan alleen de {@link TOKEN_OPSLAG}-provider.
 */
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { inject, provideAppInitializer } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { AppComponent } from './app/app.component.js';
import { routes } from './app/app.routes.js';
import { authInterceptor } from './app/kern/auth.interceptor.js';
import { AuthService } from './app/kern/auth.service.js';

void bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    // Vóór de eerste navigatie: het access-token staat alleen in het geheugen
    // en is na een herlaad weg, terwijl het refresh-token in zijn httpOnly-
    // cookie blijft staan. Zonder deze stap stuurt de routebewaking iedereen
    // na F5 naar het inlogscherm terwijl de sessie nog loopt. Het herstel faalt
    // stil: dan is er niets om te herstellen en klopt het inlogscherm juist.
    provideAppInitializer(() => inject(AuthService).herstelSessie()),
  ],
}).catch((fout: unknown) => {
  // Opstarten mislukt: toon niets gedetailleerds aan de gebruiker (§8.2).
  console.error('Opstarten mislukt', fout);
});
