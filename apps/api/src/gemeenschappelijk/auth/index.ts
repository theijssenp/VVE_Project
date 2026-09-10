/**
 * Auth-barrel — de auth-services op één plek (spec §7.2: gemeenschappelijk/auth).
 * Modules importeren rechtstreeks uit de onderliggende bestanden; deze barrel
 * bestaat voor de toekomstige NestJS-modules (F08) en testimports.
 */
export * from './wachtwoord.js';
export * from './token.js';
export * from './inlog.js';