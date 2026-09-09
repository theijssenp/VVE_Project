/**
 * Migratierunner — F03 (spec §6.1/§6.3 en §7.9 "gecontroleerd terugrolpad").
 *
 * `apps/api` is een ESM-pakket (`"type": "module"` in package.json), dus
 * `import.meta` en top-level `await` zijn hier toegestaan. De migraties-map
 * wordt opgelost ten opzichte van dit bestand (`import.meta.url`), zodat de
 * runner dezelfde bestanden pakt ongeacht de current working directory.
 *
 * Leest `DATABASE_URL` uit de omgeving (veilige default voor lokaal/test,
 * zie `connectieInfo`), voert alle `*.sql`-migraties in volgorde en
 * alleen-voorwaarts uit. Elke migratie boekt zich in `migratie_historie`,
 * zodat een tweede draai een no-op is ("tweemaal db:migrate voegt niets toe").
 *
 * Draaien:
 *    DATABASE_URL=postgres://... npm run db:migrate
 *    of zonder DATABASE_URL (veilige default:
 *      postgres://vve:vve@127.0.0.1:5432/vve, zelfde credentials als Testcontainers).
 */

import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Config ----------------------------------------------------------------

/** Veilige default (lokaal/test) — zelfde credentials als de
 * Testcontainers-helper. Uit de source komen géén echte geheimen; in
 * productie komt `DATABASE_URL` uit de omgeving (rechten 600, spec §7.9). */
const DEFAULT_URL = 'postgres://vve:vve@127.0.0.1:5432/vve';

export function connectieInfo(): { url: string } {
  const url = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error(
      `DATABASE_URL moet beginnen met postgres:// of postgresql:// (ontvangen: ${JSON.stringify(url)}).`,
    );
  }
  return { url };
}

/**
 * Migraties-map, opgelost ten opzichte van de map van dit ESM-bestand.
 * `fileURLToPath(import.meta.url)` levert het pad naar dit bestand zelf
 * (`.../run-migraties.ts`), vandaar `dirname(...)` om de map te krijgen; de
 * `migraties/`-map ligt **naast** dit bestand.
 */
export function migratiesMap(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migraties');
}

// --- Migratie-historie ------------------------------------------------------

// Elke migratie boekt zichzelf hierin als rij; de eerste regel wordt
// opgeslagen als `sql_leesbaar` voor een snelle scan. Tabel wordt door de
// runner zelf aangelegd (niet via een migratiebestand) — geen kip-ei.
const HISTORIE_DDL = [
  'CREATE TABLE IF NOT EXISTS migratie_historie (',
  '  naam            text        PRIMARY KEY,',
  '  opgevoerd_op    timestamptz NOT NULL DEFAULT now(),',
  '  sql_leesbaar    text        NOT NULL,',
  '  checksum        text',
  ')',
  '',
].join('\n');

// Bestaande databases (aangelegd vóór de checksumkolom) krijgen hem alsnog.
const HISTORIE_MIGRATIE = 'ALTER TABLE migratie_historie ADD COLUMN IF NOT EXISTS checksum text';

// Vaste sleutel voor de adviesvergrendeling. Twee runners tegelijk — CI naast een
// lokale compose-start, of twee containers die opstarten — zouden anders dezelfde
// migratie tegelijk proberen toe te passen.
const SLOT_SLEUTEL = '831492175600411';

/**
 * sha256 van de migratie-inhoud, hex. Maakt "alleen voorwaarts" afdwingbaar: wordt
 * een reeds toegepaste migratie later bewerkt, dan wijkt de checksum af en weigert
 * de runner te draaien, in plaats van een database achter te laten die niet meer
 * met de bestanden overeenkomt.
 */
export function checksumVan(sqlTekst: string): string {
  return createHash('sha256').update(sqlTekst, 'utf8').digest('hex');
}

// --- Kern -------------------------------------------------------------------

export interface Migratie {
  readonly naam: string;
  readonly bestand: string;
  readonly sql: string;
}

/** Laadt en sorteert alle `*.sql` in `map` lexicografisch (chronologisch). */
export function laadMigraties(map: string): Migratie[] {
  const bestanden = readdirSync(map)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const migraties: Migratie[] = [];
  for (const bestand of bestanden) {
    const pad = join(map, bestand);
    if (!statSync(pad).isFile()) continue;
    migraties.push({
      naam: bestand.replace(/\.sql$/, ''),
      bestand,
      sql: readFileSync(pad, 'utf8'),
    });
  }
  return migraties;
}

/**
 * Voert de migraties uit tegen `url`. Elke migratie in een eigen transactie
 * (BEGIN/COMMIT). Retourneert de uitgevoerde namen; een tweede drempel
 * levert een lege `uitgevoerde`-lijst (idempotent — DoD F03).
 */
export async function voerMigratiesUit(
  url: string,
): Promise<{ uitgevoerde: string[]; bestaand: string[] }> {
  const klant = new Client({ connectionString: url });
  await klant.connect();
  try {
    // Serialiseer gelijktijdige runs; de vergrendeling valt vanzelf weg zodra de
    // verbinding sluit, ook wanneer dit proces halverwege sneuvelt.
    await klant.query('SELECT pg_advisory_lock($1)', [SLOT_SLEUTEL]);
    await klant.query(HISTORIE_DDL);
    await klant.query(HISTORIE_MIGRATIE);
    const bestaandResultaat = await klant.query<{ naam: string; checksum: string | null }>(
      'SELECT naam, checksum FROM migratie_historie ORDER BY opgevoerd_op, naam',
    );
    const reedsUitgevoerd = new Map(bestaandResultaat.rows.map((r) => [r.naam, r.checksum]));

    const migraties = laadMigraties(migratiesMap());
    const uitgevoerde: string[] = [];
    for (const migratie of migraties) {
      if (reedsUitgevoerd.has(migratie.naam)) {
        const bekend = reedsUitgevoerd.get(migratie.naam);
        const nu = checksumVan(migratie.sql);
        if (bekend !== null && bekend !== undefined && bekend !== nu) {
          throw new Error(
            `Migratie ${migratie.naam} is gewijzigd nadat hij was toegepast ` +
              `(verwacht ${bekend.slice(0, 12)}…, gevonden ${nu.slice(0, 12)}…). ` +
              'Migraties zijn alleen voorwaarts: draai de wijziging terug en voeg een nieuwe migratie toe.',
          );
        }
        continue;
      }
      await klant.query('BEGIN');
      try {
        await klant.query(migratie.sql);
        await klant.query(
          'INSERT INTO migratie_historie (naam, sql_leesbaar, checksum) VALUES ($1, $2, $3)',
          [migratie.naam, migratie.sql.split('\n')[0] ?? '', checksumVan(migratie.sql)],
        );
        await klant.query('COMMIT');
        uitgevoerde.push(migratie.naam);
        process.stdout.write(`[migratie] ${migratie.naam} uitgevoerd\n`);
      } catch (fout: unknown) {
        await klant.query('ROLLBACK');
        const melding = fout instanceof Error ? (fout.stack ?? fout.message) : String(fout);
        process.stderr.write(`[migratie] ${migratie.naam} faalde: ${melding}\n`);
        throw fout;
      }
    }

    return { uitgevoerde, bestaand: [...reedsUitgevoerd.keys()] };
  } finally {
    await klant.end();
  }
}

// --- CLI-wrap ---------------------------------------------------------------
//
// Draai enkel als dit bestand rechtstreeks wordt aangeroepen (db:migrate),
// niet als het geïmporteerd wordt (tests). Twee signalen: `import.meta.main`
// (Node ≥ 22.18) en de realpath-comparing (overleeft relatieve npm-aanroepen;
// `import.meta.url === file://${process.argv[1]}` zou bij een relatief pad
// falen, vandaar de fallback).
const isHoofdbeheer =
  (import.meta as { main?: boolean }).main === true ||
  (typeof process.argv[1] === 'string' &&
    process.argv[1].endsWith('run-migraties.ts') &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));

if (isHoofdbeheer) {
  // In een ESM-module mag er géén top-level `return`; de CLI-logic staat
  // daarom in een async IIFE.
  void (async () => {
    const { url } = connectieInfo();
    const { uitgevoerde, bestaand } = await voerMigratiesUit(url);
    if (uitgevoerde.length === 0) {
      process.stdout.write(
        `[migratie] up-to-date — ${String(bestaand.length)} reeds uitgevoerd, geen nieuwe.\n`,
      );
    } else {
      process.stdout.write(
        `[migratie] ${String(uitgevoerde.length)} uitgevoerd: ${uitgevoerde.join(', ')}\n`,
      );
    }
  })().catch((fout: unknown) => {
    // Zonder deze vangst eindigt een mislukte migratie als unhandled rejection
    // met exitcode 0 — een falende deploy zou er dan geslaagd uitzien.
    process.stderr.write(
      `[migratie] afgebroken: ${fout instanceof Error ? (fout.stack ?? fout.message) : String(fout)}\n`,
    );
    process.exitCode = 1;
  });
}
