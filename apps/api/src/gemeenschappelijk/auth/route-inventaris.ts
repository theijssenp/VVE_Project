/**
 * Route-inventarisatie — F08 (spec §7.5, test #32).
 *
 * De inventaris leest de **werkelijk geregistreerde** routes uit de
 * Nest-metadata van de controllers, en niet uit een lijst die modules zelf
 * moeten bijhouden. Dat verschil is de hele bedoeling van test #32: een
 * handmatig register vangt alleen de ontwikkelaar die zich netjes inschrijft
 * maar per ongeluk een leeg recht opgeeft, en mist precies degene die vergeet
 * zich in te schrijven — het geval waarvoor de controle bestaat.
 *
 * `controleerRouteDeclaraties` draait bij het opstarten (zie `main.ts`) en
 * werpt met de volledige lijst overtreders. Deny by default: een route zonder
 * `@VereistRecht` laat de applicatie niet starten.
 */

import { RequestMethod, type Type } from '@nestjs/common';

// Nest exporteert deze metadatasleutels alleen via een subpad dat onder
// `moduleResolution: NodeNext` niet resolvet. De waarden zijn stabiel sinds Nest 5.
// De test controleert dat de health-route werkelijk wordt gevonden, dus als Nest
// deze sleutels ooit hernoemt, valt dat daar hoorbaar om.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

import { VEREIST_RECHT_SLEUTEL, type VereistRechtMetadata } from './vereist-recht.js';

export interface RouteDeclaratie {
  readonly methode: string;
  readonly pad: string;
  readonly recht: string | null;
}

/** Nest slaat de HTTP-methode als enum-waarde op; hier terug naar een leesbare naam. */
function methodeNaam(waarde: unknown): string {
  const naam = RequestMethod[waarde as RequestMethod];
  return typeof naam === 'string' ? naam : 'ONBEKEND';
}

function voegSamen(basis: string, deel: string): string {
  const links = basis.startsWith('/') ? basis : `/${basis}`;
  const rechts = deel === '' || deel === '/' ? '' : deel.startsWith('/') ? deel : `/${deel}`;
  return `${links}${rechts}`.replace(/\/+$/, '') || '/';
}

function leesRecht(doel: object): string | null {
  const waarde: unknown = Reflect.getMetadata(VEREIST_RECHT_SLEUTEL, doel);
  if (
    typeof waarde === 'object' &&
    waarde !== null &&
    'recht' in waarde &&
    typeof (waarde as VereistRechtMetadata).recht === 'string' &&
    (waarde as VereistRechtMetadata).recht.trim() !== ''
  ) {
    return (waarde as VereistRechtMetadata).recht;
  }
  return null;
}

/**
 * Inventariseert alle routes van de meegegeven controllerklassen, met per route
 * het gedeclareerde recht (of `null` als de declaratie ontbreekt).
 */
export function inventariseerRoutes(controllers: readonly Type<unknown>[]): RouteDeclaratie[] {
  const routes: RouteDeclaratie[] = [];
  for (const controller of controllers) {
    const basis: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const basispad = typeof basis === 'string' ? basis : '/';
    const klasseRecht = leesRecht(controller);
    const proto: object = controller.prototype as object;

    for (const naam of Object.getOwnPropertyNames(proto)) {
      if (naam === 'constructor') continue;
      const beschrijving = Object.getOwnPropertyDescriptor(proto, naam);
      const handler: unknown = beschrijving?.value;
      if (typeof handler !== 'function') continue;

      const methode: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (methode === undefined) continue; // geen route, gewoon een hulpmethode

      const deel: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      routes.push({
        methode: methodeNaam(methode),
        pad: voegSamen(basispad, typeof deel === 'string' ? deel : ''),
        // Handler-declaratie wint; anders die van de klasse (spec §7.5).
        recht: leesRecht(handler) ?? klasseRecht,
      });
    }
  }
  return routes;
}

/** Routes zonder rechtdeclaratie. Leeg betekent: alles is gedeclareerd. */
export function routesZonderRecht(controllers: readonly Type<unknown>[]): RouteDeclaratie[] {
  return inventariseerRoutes(controllers).filter((r) => r.recht === null);
}

/**
 * Opstartcontrole (test #32). Werpt als één route geen `@VereistRecht` heeft,
 * met alle overtreders in de melding — anders moet de ontwikkelaar ze één voor
 * één ontdekken.
 */
export function controleerRouteDeclaraties(controllers: readonly Type<unknown>[]): void {
  const ontbrekend = routesZonderRecht(controllers);
  if (ontbrekend.length > 0) {
    const lijst = ontbrekend.map((r) => `${r.methode} ${r.pad}`).join(', ');
    throw new Error(
      `Route(s) zonder @VereistRecht-declaratie: ${lijst}. ` +
        'Elke route declareert expliciet welk recht vereist is (spec §7.5, deny by default).',
    );
  }
}
