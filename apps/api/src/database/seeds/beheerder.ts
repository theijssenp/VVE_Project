/**
 * Maakt (of herstelt) het applicatiebeheerdersaccount — spec §3.3.
 *
 * Draai met:
 *   DATABASE_URL=... npm run --workspace @vve/api seed:beheerder -- <e-mailadres>
 *
 * Het wachtwoord wordt hier gegenereerd met de CSPRNG-generator uit blok F12 en
 * **één keer** naar de terminal geschreven. Het staat nergens in de repository
 * en nergens in een bestand: alleen de argon2id-hash gaat de database in. Kwijt
 * is kwijt — draai dit script dan opnieuw, dat is precies de knop "opnieuw
 * wachtwoord versturen" uit §3.3.
 *
 * Het account krijgt `wachtwoord_wijzigen_verplicht`, zodat de eerste inlog om
 * een eigen wachtwoord vraagt.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { hashWachtwoord } from '../../gemeenschappelijk/auth/wachtwoord.js';
import { genereerWachtwoord } from '../../gemeenschappelijk/auth/wachtwoord-generator.js';
import { persoon } from '../schema/persoon.js';

const WACHTWOORD_LENGTE = 20;

export async function maakBeheerder(
  db: ReturnType<typeof drizzle>,
  email: string,
  achternaam: string,
): Promise<{ email: string; wachtwoord: string; nieuw: boolean }> {
  const wachtwoord = genereerWachtwoord(WACHTWOORD_LENGTE);
  const hash = await hashWachtwoord(wachtwoord);

  const [bestaand] = await db
    .select({ id: persoon.id })
    .from(persoon)
    .where(eq(persoon.email, email))
    .limit(1);

  if (bestaand === undefined) {
    await db.insert(persoon).values({
      email,
      achternaam,
      wachtwoordHash: hash,
      isApplicatiebeheerder: true,
      wachtwoordWijzigenVerplicht: true,
      actief: true,
    });
    return { email, wachtwoord, nieuw: true };
  }

  // Bestaat al: alleen het wachtwoord vervangen. Bestaande sessies worden hier
  // niet ingetrokken — dat doet de knop in de applicatie wel (§3.3, test #29).
  await db
    .update(persoon)
    .set({ wachtwoordHash: hash, wachtwoordWijzigenVerplicht: true, actief: true })
    .where(eq(persoon.id, bestaand.id));
  return { email, wachtwoord, nieuw: false };
}

const isHoofdbeheer =
  (import.meta as { main?: boolean }).main === true ||
  (typeof process.argv[1] === 'string' && process.argv[1].endsWith('beheerder.ts'));

if (isHoofdbeheer) {
  void (async () => {
    const email = process.argv[2];
    if (email === undefined || !email.includes('@')) {
      process.stderr.write('Gebruik: seed:beheerder -- <e-mailadres>\n');
      process.exitCode = 1;
      return;
    }
    const url = process.env['DATABASE_URL'];
    if (url === undefined || url === '') {
      process.stderr.write('DATABASE_URL ontbreekt.\n');
      process.exitCode = 1;
      return;
    }
    const pool = new Pool({ connectionString: url });
    try {
      const uit = await maakBeheerder(drizzle(pool), email, 'Beheerder');
      process.stdout.write(
        `\n${uit.nieuw ? 'Beheerder aangemaakt' : 'Wachtwoord vervangen'}\n` +
          `  e-mailadres: ${uit.email}\n` +
          `  wachtwoord:  ${uit.wachtwoord}\n\n` +
          'Dit wachtwoord wordt nergens bewaard. Noteer het nu.\n',
      );
    } finally {
      await pool.end();
    }
  })().catch((fout: unknown) => {
    process.stderr.write(`Mislukt: ${fout instanceof Error ? fout.message : String(fout)}\n`);
    process.exitCode = 1;
  });
}
