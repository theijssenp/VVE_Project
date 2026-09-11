/**
 * Schema opnieuw opbouwen — ontwikkelhulp, niet voor productie.
 *
 * De migratierunner is bewust alleen-voorwaarts: hij bewaart per migratie een
 * sha256 en weigert te draaien zodra een reeds toegepaste migratie is bewerkt
 * (zie `run-migraties.ts`). Dat is precies goed zodra er data in staat die je
 * niet kwijt wilt, maar het remt zolang het datamodel zelf nog beweegt: elke
 * correctie op een bestaande tabel kost dan een extra migratiebestand. Dit
 * script geeft de andere modus — `public` weggooien en alles opnieuw draaien —
 * zodat bestaande migraties in deze fase gewoon aangepast mogen worden.
 *
 * ALLES IN DE DATABASE GAAT WEG: VvE's, personen, sessies, apparaten, auditlog.
 *
 * Draaien (vanuit de repo-root):
 *   npm run db:opnieuw --workspace @vve/api
 *   npm run db:opnieuw:seed --workspace @vve/api -- <e-mailadres>
 *
 * De rollen `vve_app` / `vve_migratie` / `vve_platform` overleven dit: rollen
 * zijn cluster-breed en niet schema-gebonden. Migratie 0003 maakt ze aan achter
 * een bestaanscontrole, dus de herbouw struikelt er niet over. De extensies
 * (citext, pgcrypto, pg_trgm) staan wél in `public` en verdwijnen mee; migratie
 * 0001 zet ze terug.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Hosts die als "mijn eigen machine" gelden. Dit is de enige harde grens die
 * dit script kent, en bewust niet `NODE_ENV`: het sjabloon `.env.voorbeeld`
 * zet `NODE_ENV=production` (het is geschreven voor de VPS), dus een
 * ontwikkelmachine die dat bestand kopieert draagt dat label zonder dat er iets
 * productie-achtigs aan is. Een wachter die in de normale werkgang elke keer
 * ten onrechte afgaat, leert je hem te omzeilen — dan is hij minder waard dan
 * geen wachter. Het adres van de database liegt niet.
 */
const LOKALE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class OnveiligDoelFout extends Error {}

/**
 * Weigert alles wat niet aantoonbaar een lokale database is.
 *
 * Let op de bekende ontsnapping: een SSH-tunnel maakt een productiedatabase
 * óók bereikbaar op 127.0.0.1. Wie tunnelt, weet dat — daarvoor bestaat geen
 * controle die dit script kan uitvoeren.
 */
export function controleerDoel(url: string): { host: string; database: string } {
  let ontleed: URL;
  try {
    ontleed = new URL(url);
  } catch {
    throw new OnveiligDoelFout(`DATABASE_URL is geen geldige URL: ${JSON.stringify(url)}`);
  }
  const host = ontleed.hostname.replace(/^\[|\]$/g, '');
  if (!LOKALE_HOSTS.has(host)) {
    throw new OnveiligDoelFout(
      `Weigering: dit script gooit een heel schema weg en draait alleen tegen een ` +
        `lokale database. DATABASE_URL wijst naar "${host}".`,
    );
  }
  return { host, database: ontleed.pathname.replace(/^\//, '') };
}

/** Gooit `public` weg en zet hem terug zoals PostgreSQL 16 hem zelf aanlegt. */
export async function herbouwSchema(url: string): Promise<void> {
  const klant = new Client({ connectionString: url });
  await klant.connect();
  try {
    await klant.query('DROP SCHEMA IF EXISTS public CASCADE');
    // PostgreSQL 15+ legt `public` aan met pg_database_owner als eigenaar en
    // zonder CREATE voor PUBLIC. Dat exact nabootsen, anders staat de lokale
    // database ruimer open dan een verse installatie — en dan test je iets
    // anders dan wat er in productie draait.
    await klant.query('CREATE SCHEMA public AUTHORIZATION pg_database_owner');
    await klant.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
    await klant.query("COMMENT ON SCHEMA public IS 'standard public schema'");
  } finally {
    await klant.end();
  }
}

/** Draait de migratierunner als apart proces — zie de opmerking bij de CLI. */
function draaiMigraties(url: string): void {
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'run-migraties.ts');
  const uit = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
  if (uit.status !== 0) {
    throw new Error(`Migreren faalde (afsluitcode ${String(uit.status ?? -1)}).`);
  }
}

// --- CLI --------------------------------------------------------------------
//
// De runner wordt als kindproces aangeroepen en niet geïmporteerd. Node's
// type-stripping lost een `.js`-specifier niet op naar het `.ts`-bestand
// ernaast (geverifieerd op v22.23), terwijl `tsc` met NodeNext juist die
// `.js`-specifier eist. Een directe import zou dus óf de build óf het draaien
// vanuit `src` breken. Vanuit `src` draaien is hier het punt: dan lees je altijd
// de .sql-bestanden zoals ze nu op schijf staan, nooit een verouderde `dist`.

const isHoofdbeheer =
  (import.meta as { main?: boolean }).main === true ||
  (typeof process.argv[1] === 'string' && process.argv[1].endsWith('opnieuw-opbouwen.ts'));

if (isHoofdbeheer) {
  void (async () => {
    const url = process.env['DATABASE_URL'];
    if (url === undefined || url === '') {
      process.stderr.write('DATABASE_URL ontbreekt.\n');
      process.exitCode = 1;
      return;
    }
    const doel = controleerDoel(url);
    if (process.env['NODE_ENV'] === 'production') {
      process.stdout.write(
        `let op: NODE_ENV=production, maar de database staat op ${doel.host} en geldt\n` +
          '        daarom als lokaal. Zet NODE_ENV=development in .env voor lokaal werk;\n' +
          '        het sjabloon .env.voorbeeld is voor de VPS geschreven.\n',
      );
    }
    process.stdout.write(`[herbouw] schema public weggooien in "${doel.database}"…\n`);
    await herbouwSchema(url);
    draaiMigraties(url);
    process.stdout.write('[herbouw] klaar — leeg schema, alle migraties opnieuw uitgevoerd.\n');
  })().catch((fout: unknown) => {
    process.stderr.write(`${fout instanceof Error ? fout.message : String(fout)}\n`);
    process.exitCode = 1;
  });
}
