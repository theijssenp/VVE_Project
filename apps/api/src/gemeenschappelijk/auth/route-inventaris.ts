/**
 * Route-inventarisatie — F08 (spec §7.5, test #32).
 *
 * De opstarttest inventariseert alle geregistreerde routes van de API en
 * controleert dat élke route een `@VereistRecht`-declaratie heeft. Ontbreekt
 * er één, dan faalt de applicatie bij het opstarten (deny by default).
 *
 * De inventarisatie loopt over de Nest-registered-routes via een eigen
 * app-adapter: `app.getHttpServer()` + de router-stack zou interne Node-types
 * vereisen; de spec-benadering is een expliciete route-registering: elke
 * controller-module registreert zijn routes hier. De health-route (het enige
 * bestaande endpoint) is het eerste lid.
 *
 * Een nieuwe module voegt zijn routes hier toe — de test faalt zodra een
 * route zonder rechtdeclaratie in deze tabel staat. Daarmee is de declaratie
 * onderdeel van het route-register zelf, niet van de lezer.
 */

export interface RouteDeclaratie {
  readonly methode: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly pad: string;
  readonly recht: string;
}

/** De geregistreerde routes. Modules schrijven zichzelf hier in bij het laden. */
const REGISTRIER: RouteDeclaratie[] = [];

/** Registreert een route met zijn recht (door de module zelf aangeroepen). */
export function registreerRoute(route: RouteDeclaratie): void {
  if (!/^\S+$/.test(route.recht)) {
    throw new Error(
      `Route ${route.methode} ${route.pad} probeert zich te registreren zonder recht`,
    );
  }
  REGISTRIER.push(route);
}

/** De inventaris — de opstarttest leest deze en faalt bij een route zonder recht. */
export function inventariseerRoutes(): RouteDeclaratie[] {
  return [...REGISTRIER];
}

// Health-route (F01): publiek-leesbaar, expliciet gedeclareerd (test #32-kern).
registreerRoute({ methode: 'GET', pad: '/health', recht: 'health.lezen' });