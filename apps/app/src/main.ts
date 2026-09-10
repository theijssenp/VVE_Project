/**
 * Opstartpunt van de Ionic-schil — F11.
 *
 * PWA eerst (spec §7.8): dit draait als gewone webapp; de Capacitor-build komt
 * in blok N01 en vervangt dan alleen de {@link TOKEN_OPSLAG}-provider.
 */
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { AppComponent } from './app/app.component.js';
import { routes } from './app/app.routes.js';
import { authInterceptor } from './app/kern/auth.interceptor.js';

void bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
}).catch((fout: unknown) => {
  // Opstarten mislukt: toon niets gedetailleerds aan de gebruiker (§8.2).
  console.error('Opstarten mislukt', fout);
});
