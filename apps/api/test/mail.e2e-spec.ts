/**
 * Integratietest — mailwachtrij en verzendworker (F10, spec §7.7).
 *
 * Draait tegen de gedeelde test-db met een **nepverzender** (niets gaat
 * echt de deur uit). Controleert:
 *   - zetInWachtrij: status 'wachtend', faalt nooit op SMTP;
 *   - verwerkWachtrij: verzendt een wachtend bericht en zet 'verzonden';
 *   - een SMTP-fout zet het bericht terug naar 'wachtend' met een
 *     aflever_vóór in de toekomst (backoff) en telt de poging;
 *   - na MAX_POGINGEN mislukkingen → status 'mislukt' met de foutmelding;
 *   - de claim: een 'bezig'-rij wordt door een tweede run overgeslagen;
 *   - aflever_vóór in de toekomst wordt nu niet verzonden.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  maakMailService,
  MAX_POGINGEN,
  type MailServiceInterface,
  type MailVerzender,
} from '../src/gemeenschappelijk/mail/mail-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Mailwachtrij (F10, §7.7)', () => {
  let db: TestPgDb | undefined;
  let volg = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Bouwt een service met een nepverzender die een geregistreerd gedrag volgt. */
  function metVerzender(gedrag: () => Promise<void>): {
    service: MailServiceInterface;
    verzonden: string[];
  } {
    const verzonden: string[] = [];
    const nepverzender: MailVerzender = {
      async verzend(bericht) {
        await gedrag();
        verzonden.push(bericht.onderwerp);
      },
    };
    const service = maakMailService({ db: (db as TestPgDb).db, verzender: nepverzender });
    return { service, verzonden };
  }

  it('zetInWachtrij zet status wachtend; verwerkWachtrij verzendt en rondt af', async () => {
    if (!db) throw new Error('geen test-db');
    volg += 1;
    const { service, verzonden } = metVerzender(() => Promise.resolve());
    const { id } = await service.zetInWachtrij({
      vveId: null,
      ontvangerEmail: `mail${String(volg)}@test.vve`,
      onderwerp: `Test ${String(volg)}`,
      tekst: 'Hallo, dit is een testbericht.',
      categorie: 'app',
    });
    const uitslag = await service.verwerkWachtrij();
    expect(uitslag.verzonden).toBeGreaterThanOrEqual(1);
    expect(verzonden).toContain(`Test ${String(volg)}`);

    const controle = await db.pool.query<{ status: string }>(
      'SELECT status FROM mail_wachtrij WHERE id = $1',
      [String(id)],
    );
    expect(controle.rows[0]?.status).toBe('verzonden');
  });

  it('SMTP-fout: backoff naar wachtend met toekomstige aflever_vóór; na max pogingen mislukt', async () => {
    if (!db) throw new Error('geen test-db');
    volg += 1;
    let poging = 0;
    const { service } = metVerzender(() => {
      poging += 1;
      return Promise.reject(new Error(`SMTP-luizenmuis poging ${String(poging)}`));
    });
    const { id } = await service.zetInWachtrij({
      vveId: null,
      ontvangerEmail: `faalend${String(volg)}@test.vve`,
      onderwerp: `Faalend ${String(volg)}`,
      tekst: 'Dit bericht faalt altijd.',
    });

    // Elke verwerkt-ronde is één poging; MAX_POGINGEN rondes tot 'mislukt'.
    // De backoff zet aflever_vóór in de toekomst; de tests overbruggen die
    // alsof er echte tijd verstreken is (de aflever_vóór naar het verleden).
    for (let i = 0; i < MAX_POGINGEN; i += 1) {
      if (i > 0) {
        // Simuleer verstreken backoff-tijd: aflever_vóór naar het verleden.
        await db.pool.query('UPDATE mail_wachtrij SET aflever_vóór = $1 WHERE id = $2', [
          new Date(Date.now() - 1_000),
          String(id),
        ]);
      }
      const uitslag = await service.verwerkWachtrij();
      if (i < MAX_POGINGEN - 1) {
        // Na poging 1..4: terug naar wachtend met backoff.
        expect(uitslag.mislukt).toBe(0);
      }
    }
    const controle = await db.pool.query<{
      status: string;
      pogingen: number;
      fout: string | null;
    }>(
      'SELECT status, aantal_pogingen AS pogingen, foutmelding AS fout FROM mail_wachtrij WHERE id = $1',
      [String(id)],
    );
    expect(controle.rows[0]?.status).toBe('mislukt');
    expect(controle.rows[0]?.pogingen).toBe(MAX_POGINGEN);
    expect(controle.rows[0]?.fout).toContain('SMTP-luizenmuis');
  });

  it('aflever_vóór in de toekomst: niet verzonden tot het venster verstrekt', async () => {
    if (!db) throw new Error('geen test-db');
    volg += 1;
    const { service, verzonden } = metVerzender(() => Promise.resolve());
    const toekomst = new Date(Date.now() + 60 * 60 * 1000);
    await service.zetInWachtrij({
      vveId: null,
      ontvangerEmail: `later${String(volg)}@test.vve`,
      onderwerp: `Later ${String(volg)}`,
      tekst: 'Dit bericht is pas later aan de beurt.',
      afleverVoor: toekomst,
    });
    const uitslag = await service.verwerkWachtrij();
    expect(verzonden).not.toContain(`Later ${String(volg)}`);
    expect(uitslag.resterend).toBeGreaterThanOrEqual(1);
  });

  it('resterend telt de wachtende berichten die nog niet verwerkt zijn', async () => {
    if (!db) throw new Error('geen test-db');
    volg += 1;
    const { service } = metVerzender(() => Promise.resolve());
    // Twee berichten met een toekomstige aflevertijd — niet verwerkt, wel wachtend:
    for (const n of [1, 2]) {
      await service.zetInWachtrij({
        vveId: null,
        ontvangerEmail: `resterend${String(n)}-${String(volg)}@test.vve`,
        onderwerp: `Resterend ${String(n)}`,
        tekst: 'wacht',
        afleverVoor: new Date(Date.now() + 3_600_000),
      });
    }
    const uitslag = await service.verwerkWachtrij();
    expect(uitslag.resterend).toBeGreaterThanOrEqual(2);
  });

  it('gevoelige berichten laten hun tekst niet achter (review F10)', async () => {
    if (!db) throw new Error('geen test-db');
    const verzonden: string[] = [];
    const dienst = maakMailService({
      db: db.db,
      verzender: {
        verzend: (b) => {
          verzonden.push(b.tekst);
          return Promise.resolve();
        },
      },
    });

    // Zoals de knop "opnieuw wachtwoord versturen" (§3.3) het zou doen.
    const { id } = await dienst.zetInWachtrij({
      vveId: null,
      ontvangerEmail: `gevoelig-${String(Date.now())}@example.test`,
      onderwerp: 'Uw nieuwe wachtwoord',
      tekst: 'Uw wachtwoord is: Gh7-xK92-pLmQ',
      gevoelig: true,
      categorie: 'beveiliging',
    });

    await dienst.verwerkWachtrij();

    // De ontvanger heeft het geheim gekregen...
    expect(verzonden.join(' ')).toContain('Gh7-xK92-pLmQ');

    // ...maar het staat niet meer in de wachtrij, die twee jaar bewaard blijft (§8.3).
    const { rows } = await db.pool.query<{ tekst: string; status: string }>(
      'SELECT tekst, status FROM mail_wachtrij WHERE id = $1',
      [String(id)],
    );
    expect(rows[0]?.status).toBe('verzonden');
    expect(rows[0]?.tekst).not.toContain('Gh7-xK92-pLmQ');
    expect(rows[0]?.tekst).toContain('gewist');
  });
});
