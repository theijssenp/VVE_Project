export * as financieel from './financieel/index.js';
export * as bank from './bank/index.js';

// Topniveau-herexports van de kernwaarden (spec §7.3), zodat zowel de
// namespaced als de vlakke import werken: `import { Bedrag } from '@vve/domein'`.
export {
  Bedrag,
  BedragFout,
  MAX_CENTEN,
  formatteerEuro,
  parseInvoer,
} from './financieel/bedrag.js';
export { somCenten, verdeelGrootsteRest } from './financieel/delen.js';
export type { Klok, KalenderDag } from './financieel/klok.js';
export { grootsteRestVerdeler } from './financieel/verdeler.js';
export type { Verdeler, EenheidId } from './financieel/verdeler.js';

// Bankimport (blok B02); de parsers zijn bewust eigen domeincode (§10).
export { leesCamt053, bedragNaarCenten, afschriftSluit, CamtFout } from './bank/camt053.js';
export type { Bankmutatie, Camt053Afschrift } from './bank/camt053.js';
