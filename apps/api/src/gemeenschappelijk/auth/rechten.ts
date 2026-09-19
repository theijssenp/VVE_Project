/**
 * Rechtenmatrix per rol — hoort bij de `RolGuard` (spec §3.1, §3.2, §7.5 stap 3).
 *
 * Tot nu toe toetste de `RolGuard` alleen **dát** een route een recht
 * declareert, niet of de rol van de aanvrager dat recht heeft. De `TenantGuard`
 * eist een `rol_toewijzing` in de VvE, maar kijkt niet naar welke rol dat is.
 * Gevolg: iedereen met eender welke rol in een VvE kwam bij elk tenant-endpoint
 * van die VvE — een eigenaar kon eenheden aanmaken, nota's genereren en het
 * boekjaar afsluiten. `@VereistRecht` was daarmee documentatie in plaats van een
 * controle.
 *
 * Dit bestand sluit dat gat voor de rollen waar het hardst telt: `eigenaar` en
 * `bewoner`. De spec is voor die twee ondubbelzinnig (§3.1) — een eigenaar ziet
 * zijn eigen eenheid, zijn eigen nota's en de stukken die voor hem bestemd zijn;
 * een bewoner nog minder. Alles wat zij mogen, loopt via het eigenaarsportaal
 * (V07), dat per definitie al op de eigen eenheid filtert. Daarom is de
 * allowlist precies dat portaal en niets meer: elk ander recht levert 403.
 *
 * **Bewust nog niet dichtgezet:** de fijnere verdeling tussen de bestuursrollen.
 * De spec wil dat een bestuurslid geen gebruikersbeheer doet, een
 * penningmeester geen incassobestanden definitief maakt en een kascommissielid
 * alleen leest. Die staffelt dit bestand nog niet — die rollen houden de
 * bestaande, volledige toegang. Dat is geen goedkeuring maar een afbakening: de
 * eigenaar/bewoner-scheiding is de scheiding die nú nodig is, omdat er
 * eigenaarsaccounts uitgedeeld gaan worden. De rest hoort bij een eigen blok,
 * met eigen tests per rol.
 */

/**
 * Rollen met volledige functionele toegang binnen hun eigen VvE (§3.1).
 *
 * `applicatiebeheerder` staat er niet tussen: die rol is systeembreed en loopt
 * via een eigen controle (`#eisApplicatiebeheerder`), niet via een
 * `rol_toewijzing` in een VvE.
 */
const VOLLEDIGE_ROLLEN: ReadonlySet<string> = new Set([
  'beheerder',
  'voorzitter',
  'penningmeester',
  'secretaris',
  'bestuurslid',
  'kascommissie',
]);

/**
 * Wat een eigenaar mag: zijn eigen portaal, en het bijwerken van zijn eigen
 * gegevens. Het portaal-endpoint bepaalt zelf welke eenheid dat is — de rol
 * geeft geen toegang tot een eenheid, het portaal leidt hem af uit de sessie.
 */
const RECHTEN_EIGENAAR: ReadonlySet<string> = new Set(['portaal.lezen', 'portaal.gegevens']);

/**
 * Een bewoner/huurder heeft geen financiële toegang (§3.1, AC2.6). Het portaal
 * toont hem mededelingen en huisregels; dezelfde route, andere inhoud.
 */
const RECHTEN_BEWONER: ReadonlySet<string> = new Set(['portaal.lezen', 'portaal.gegevens']);

function rechtenVoorRol(rol: string): ReadonlySet<string> | 'alles' {
  if (VOLLEDIGE_ROLLEN.has(rol)) return 'alles';
  if (rol === 'eigenaar') return RECHTEN_EIGENAAR;
  if (rol === 'bewoner') return RECHTEN_BEWONER;
  // Onbekende rol: niets. Deny by default (§3.2) — een rol die later aan het
  // enum wordt toegevoegd en hier vergeten wordt, krijgt geen toegang in plaats
  // van alle toegang.
  return new Set<string>();
}

/**
 * Mag iemand met deze rollen dit recht uitoefenen?
 *
 * Een persoon kan meerdere rollen in dezelfde VvE hebben (§3.1); de ruimste
 * telt. Een lege rollenlijst betekent geen toegang — maar zover komt het in de
 * praktijk niet, want de `TenantGuard` heeft dan al geweigerd.
 */
export function rolHeeftRecht(rollen: readonly string[], recht: string): boolean {
  return rollen.some((rol) => {
    const toegestaan = rechtenVoorRol(rol);
    return toegestaan === 'alles' || toegestaan.has(recht);
  });
}
