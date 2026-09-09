/**
 * Drizzle-opzet (F03, spec §7.2 "database/schema").
 *
 * Wijzen naar waar het Drizzle-schema en de migratie-mappen staan:
 *    - `schema`   -> het src/database/schema-index (tabel- en typedefinities
 *                    voor de repository-laag),
 *    - `out`      -> de handgeschreven migraties (leidend, spec §6.1/§6.3),
 *    - `dialect`  -> PostgreSQL 16.
 *
 * De migraties zijn **leidend** (handgeschreven SQL, gedraaid door de eigen
 * runner `src/database/run-migraties.ts` via `db:migrate` — DE leverancier).
 * Dit bestand is de tegenpartij: een eventueel `drizzle-kit generate`-run
 * (optioneel, als `npx drizzle-kit`) gebruikt het om het schema te diffen.
 * `drizzle-kit` is bewust géén runtime- of dev-afhankelijkheid in
 * `package.json` — de migraties zijn niet door drizzle-kit gegenereerd.
 *
 * Dit bestand wordt niet gecompileerd door de workspace-tsconfig
 * (`drizzle.config.ts` staat niet in de `include`-lijst, net als
 * `vitest.config.ts` expliciet wél — zie `apps/api/tsconfig.json`), en staat in
 * de `ignores` van de eslint-config. Het is dus alleen een declaratie.
 */

const config = {
  dialect: 'postgresql' as const,
  schema: './src/database/schema/index.ts',
  out: './src/database/migraties',
  // Veilige default (lokaal/test), dezelfde credentials als de
  // Testcontainers-helper. In productie: DATABASE_URL uit de omgeving
  // (rechten 600, spec §7.9).
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://vve:vve@127.0.0.1:5432/vve',
  },
  strict: true,
};

export default config;
