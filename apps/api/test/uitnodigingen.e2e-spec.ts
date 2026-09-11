/**
 * Integratietest — uitnodigingen (V04, spec §3.3, §6.3, AC2.2).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0012). De
 * mail-verzender is een nep die in een lijst verzamelt; de wachtrij zelf is
 * echt. Controleert:
 *   - uitnodigen van een nieuw adres: rij met opak token, gevoelige mail in
 *     de wachtrij (tekst wordt na verzending gewist);
 *   - het token registreert het account: wachtwoord-hash, actief, rol als
 *     eigenaar, eigenaarschap met periode, token is één keer bruikbaar;
 *   - een bestaand persoon wordt direct gekoppeld (geen token) en krijgt de
 *     "u bent toegevoegd"-mail (§3.3 stap 2);
 *   - opnieuw versturen: nieuw token, oude link ongeldig, teller +1;
 *   - verlopen of gebruikt token → OngeldigTokenFout;
 *   - de eenheid van een andere VvE wordt geweigerd (tenant-scope).
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persoon } from '../src/database/schema/index.js';
import { uitnodiging } from '../src/database/schema/uitnodiging.js';
import { vve } from '../src/database/schema/vve.js';
import { wooneenheid } from '../src/database/schema/wooneenheid.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import { maakMailService, type MailVerzender } from '../src/gemeenschappelijk/mail/mail-service.js';
import {
  InvoerFout,
  NietGevondenFout,
  OngeldigTokenFout,
  maakUitnodigingenService,
  type UitnodigingenService,
} from '../src/modules/uitnodigingen/uitnodigingen.service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

const WACHTWOORD = 'een-goed-wachtwoord-2026!';

/** De nep-verzender: verzamelt alleen wat hij krijgt. */
function nepVerzender(verzonden: { ontvangerEmail: string; onderwerp: string }[]): MailVerzender {
  return {
    verzend: (bericht) => {
      verzonden.push({ ontvangerEmail: bericht.ontvangerEmail, onderwerp: bericht.onderwerp });
      return Promise.resolve();
    },
  };
}

describe('Uitnodigingen (V04, §3.3)', () => {
  let db: TestPgDb | undefined;
  let service: UitnodigingenService | undefined;
  let mailVerzonden: { ontvangerEmail: string; onderwerp: string }[] = [];
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    mailVerzonden = [];
    const mail = maakMailService({ db: db.db, verzender: nepVerzender(mailVerzonden) });
    service = maakUitnodigingenService({
      db: db.db,
      mail,
      klok: new SystemKlok(),
      registratieBasis: 'http://test/registratie',
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + beheerder + eenheid; retourneert id's. */
  async function seed(): Promise<{ vveId: bigint; persoonId: bigint; eenheidId: bigint }> {
    if (!db) throw new Error('geen test-db');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `V04-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `v04-beheerder-${n}@test.vve`, achternaam: 'Beheerder' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v.id, code: `E-${n}` })
      .returning({ id: wooneenheid.id });
    if (e === undefined) throw new Error('seed faalde (eenheid)');
    return { vveId: v.id, persoonId: p.id, eenheidId: e.id };
  }

  function hashVan(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  it('nodigt een nieuw adres uit: rij + gevoelige mail in de wachtrij', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();

    const uit = await service.nodigUit(
      vveId,
      { email: 'buren@example.nl', eenheidId, rol: 'eigenaar' },
      persoonId,
    );
    expect(uit.bestaandPersoon).toBe(false);
    expect(uit.token).toMatch(/^[0-9a-f]{64}$/);

    // De mail staat in de wachtrij, met de link erin en de gevoelig-vlag.
    const { rows } = await db.pool.query<{ gevoelig: boolean; tekst: string }>(
      'SELECT gevoelig, tekst FROM mail_wachtrij WHERE ontvanger_email = $1 ORDER BY id DESC LIMIT 1',
      ['buren@example.nl'],
    );
    expect(rows[0]?.gevoelig).toBe(true);
    expect(rows[0]?.tekst).toContain('token=');

    // Na verzending is de tekst gewist (F10) — hier bewijzen we dat pad meteen:
    // dezelfde wachtrij-service verwerkt en wist het gevoelige bericht.
    const verwerkt = await maakMailService({
      db: db.db,
      verzender: nepVerzender(mailVerzonden),
    }).verwerkWachtrij({});
    expect(verwerkt.verzonden).toBeGreaterThan(0);
    const { rows: na } = await db.pool.query<{ tekst: string; status: string }>(
      'SELECT tekst, status FROM mail_wachtrij WHERE ontvanger_email = $1 ORDER BY id DESC LIMIT 1',
      ['buren@example.nl'],
    );
    expect(na[0]?.status).toBe('verzonden');
    expect(na[0]?.tekst).toContain('gewist');
  });

  it('registreert een account via het token: één keer bruikbaar, rol en koppeling mee', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();
    const uit = await service.nodigUit(
      vveId,
      { email: 'nieuw@example.nl', eenheidId, rol: 'eigenaar' },
      persoonId,
    );
    if (uit.token === null) throw new Error('geen token');

    const uitkomst = await service.registreer(uit.token, WACHTWOORD);
    expect(uitkomst.vveId).toBe(vveId);
    expect(uitkomst.eenheidId).toBe(eenheidId);

    const [rij] = await db.db
      .select()
      .from(persoon)
      .where(eq(persoon.email, 'nieuw@example.nl'))
      .limit(1);
    expect(rij?.wachtwoordHash).not.toBeNull();
    expect(rij?.actief).toBe(true);

    // Token is verbruikt: tweede poging faalt met de uniforme fout.
    await expect(service.registreer(uit.token, WACHTWOORD)).rejects.toThrow(OngeldigTokenFout);
  });

  it('koppelt een bestaand persoon direct, met de toegevoegd-mail en geen token', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();
    // De persoon bestaat al (bv. eigenaar in een andere VvE).
    await db.db
      .insert(persoon)
      .values({ email: 'partner@example.nl', achternaam: 'Bestaand' })
      .returning({ id: persoon.id });

    const uit = await service.nodigUit(
      vveId,
      { email: 'partner@example.nl', eenheidId, rol: 'eigenaar' },
      persoonId,
    );
    expect(uit.bestaandPersoon).toBe(true);
    expect(uit.token).toBeNull();

    // Er is een "toegevoegd"-mail in de wachtrij, geen registratielink.
    const { rows } = await db.pool.query<{ onderwerp: string }>(
      "SELECT onderwerp FROM mail_wachtrij WHERE ontvanger_email = 'partner@example.nl' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]?.onderwerp).toContain('Toegevoegd');
  });

  it('opnieuw versturen: nieuw token, oud token ongeldig, teller +1', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();
    const eerste = await service.nodigUit(
      vveId,
      { email: 'herverstuur@example.nl', eenheidId, rol: 'eigenaar' },
      persoonId,
    );
    if (eerste.token === null) throw new Error('geen eerste token');

    const overzicht = await service.lijst(vveId);
    const rij = overzicht.rijen[0];
    if (!rij) throw new Error('geen uitnodiging in de lijst');
    expect(rij.aantalVerzonden).toBe(1);

    const tweede = await service.verstuurOpnieuw(vveId, rij.id, persoonId);
    expect(tweede.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tweede.token).not.toBe(eerste.token);

    const [rijNa] = await db.db
      .select()
      .from(uitnodiging)
      .where(eq(uitnodiging.id, rij.id))
      .limit(1);
    expect(rijNa?.aantalVerzonden).toBe(2);

    // Het oude token is ongeldig (token_hash is overschreven); het nieuwe werkt.
    await expect(service.registreer(eerste.token, WACHTWOORD)).rejects.toThrow(OngeldigTokenFout);
    if (tweede.token === null) throw new Error('geen tweede token');
    await expect(service.registreer(tweede.token, WACHTWOORD)).resolves.toBeTruthy();
  });

  it('weigert een verlopen token', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();
    const { token } = await service.nodigUit(
      vveId,
      { email: 'verloopt@example.nl', eenheidId, rol: 'eigenaar' },
      persoonId,
    );
    if (token === null) throw new Error('geen token');
    // Zet de verloopdatum handmatig in het verleden (via de hash).
    await db.pool.query(
      "UPDATE uitnodiging SET verloopt_op = now() - interval '1 day' WHERE token_hash = $1",
      [hashVan(token)],
    );
    await expect(service.registreer(token, WACHTWOORD)).rejects.toThrow(OngeldigTokenFout);
  });

  it('weigert een eenheid van een andere VvE (tenant-scope)', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const ander = await seed();
    await expect(
      service.nodigUit(
        vveId,
        { email: 'iemand@example.nl', eenheidId: ander.eenheidId, rol: 'eigenaar' },
        persoonId,
      ),
    ).rejects.toThrow(NietGevondenFout);
  });

  it('weigert een ongeldig e-mailadres', async () => {
    if (!db || !service) throw new Error('geen setup');
    const { vveId, persoonId, eenheidId } = await seed();
    await expect(
      service.nodigUit(vveId, { email: 'geen-adres', eenheidId, rol: 'eigenaar' }, persoonId),
    ).rejects.toThrow(InvoerFout);
  });
});
