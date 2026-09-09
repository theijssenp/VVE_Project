export * as financieel from './financieel/index.js';

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
