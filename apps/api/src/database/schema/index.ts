/**
 * Drizzle-schema barrel — re-export van alle tabellen/typen uit de vve/persoon
 * laag (spec §6.3). Latere blokken voegen hier hun tabellen aan toe
 * (eenheden, nota's, grootboek, …).
 */

export { vveStatus, modelreglement, communicatieWijze } from './enums.js';
export { citext, bytea } from './types.js';
export { vve } from './vve.js';
export { persoon } from './persoon.js';
export type { Vve, NieuweVve } from './vve.js';
export type { Persoon, NieuwePersoon } from './persoon.js';
