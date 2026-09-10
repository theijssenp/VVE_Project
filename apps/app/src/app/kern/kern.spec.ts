/**
 * Tests voor de beveiligingsrelevante kern van de clientschil (F11).
 *
 * Deze modules zijn bewust vrij van Angular, zodat het gedrag dat er echt toe
 * doet — waar tokens blijven, hoe vaak er ververst wordt, wat een gebruiker te
 * zien krijgt bij een fout — zonder browser te toetsen is.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CookieTokenOpslag,
  GeheugenAccessToken,
  VeiligeOpslagTokenOpslag,
} from './token-opslag.js';
import { EnkeleVerversing, magVerversen } from './verversing.js';
import { isSessieVerlopen, naarApiFout } from './fout.js';

describe('Tokenopslag (spec §7.6)', () => {
  it('bewaart het refresh-token op web nergens: dat is de httpOnly-cookie', async () => {
    const opslag = new CookieTokenOpslag();
    await opslag.bewaarRefresh('geheim-token');
    await expect(opslag.leesRefresh()).resolves.toBeNull();
  });

  it('valt op native niet stilletjes terug op onveilige opslag', async () => {
    const opslag = new VeiligeOpslagTokenOpslag();
    await expect(opslag.bewaarRefresh('t')).rejects.toThrow(/nog niet gekoppeld/);
  });

  it('houdt het access-token alleen in het geheugen', () => {
    const geheugen = new GeheugenAccessToken();
    expect(geheugen.aanwezig).toBe(false);
    geheugen.zet('abc');
    expect(geheugen.lees()).toBe('abc');
    geheugen.zet(null);
    expect(geheugen.aanwezig).toBe(false);
  });

  it('raakt localStorage en sessionStorage niet aan', async () => {
    // Alles wat JavaScript kan lezen, kan een XSS-fout ook lezen (§7.6).
    const opslag = new CookieTokenOpslag();
    const winkel = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', winkel);
    vi.stubGlobal('sessionStorage', winkel);
    await opslag.bewaarRefresh('geheim');
    await opslag.leesRefresh();
    await opslag.wis();
    expect(winkel.setItem).not.toHaveBeenCalled();
    expect(winkel.getItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('Enkelvoudige verversing (spec §7.6)', () => {
  it('wisselt het refresh-token maar één keer in bij gelijktijdige 401-en', async () => {
    // Twee keer inwisselen leest de server als tokendiefstal: die trekt dan de
    // hele familie in en logt de gebruiker overal uit.
    const verversing = new EnkeleVerversing();
    let aanroepen = 0;
    const ververs = async (): Promise<string> => {
      aanroepen += 1;
      await new Promise((r) => setTimeout(r, 5));
      return 'nieuw-token';
    };

    const uitkomsten = await Promise.all(
      Array.from({ length: 8 }, () => verversing.voerUit(ververs)),
    );

    expect(aanroepen).toBe(1);
    expect(uitkomsten.every((t) => t === 'nieuw-token')).toBe(true);
  });

  it('laat een volgende ronde weer toe nadat de vorige klaar is', async () => {
    const verversing = new EnkeleVerversing();
    let aanroepen = 0;
    const ververs = (): Promise<string> => {
      aanroepen += 1;
      return Promise.resolve('t');
    };
    await verversing.voerUit(ververs);
    await verversing.voerUit(ververs);
    expect(aanroepen).toBe(2);
    expect(verversing.loopt).toBe(false);
  });

  it('geeft de lus vrij als het verversen faalt', async () => {
    const verversing = new EnkeleVerversing();
    await expect(verversing.voerUit(() => Promise.reject(new Error('stuk')))).rejects.toThrow();
    expect(verversing.loopt).toBe(false);
  });

  it('vervest niet op de auth-endpoints zelf', () => {
    expect(magVerversen('/api/auth/verversen')).toBe(false);
    expect(magVerversen('/api/auth/inloggen')).toBe(false);
    expect(magVerversen('/api/auth/mfa')).toBe(false);
    expect(magVerversen('/api/notas/123')).toBe(true);
  });
});

describe('Foutafhandeling (spec §8.2)', () => {
  it('neemt de melding van de server over, inclusief referentie', () => {
    const fout = naarApiFout(403, {
      code: 'recht.ontbreekt',
      melding: 'U heeft geen toegang.',
      referentie: 'abc-123',
    });
    expect(fout).toEqual({
      code: 'recht.ontbreekt',
      melding: 'U heeft geen toegang.',
      referentie: 'abc-123',
      status: 403,
    });
  });

  it('valt terug op een korte tekst als de server niets bruikbaars gaf', () => {
    const fout = naarApiFout(500, '<html>Internal Server Error</html>');
    expect(fout.code).toBe('onbekend');
    expect(fout.melding).not.toContain('html');
    expect(fout.referentie).toBeNull();
  });

  it('herkent een verlopen sessie alleen aan een 401', () => {
    expect(isSessieVerlopen(naarApiFout(401, null))).toBe(true);
    expect(isSessieVerlopen(naarApiFout(403, null))).toBe(false);
  });
});
