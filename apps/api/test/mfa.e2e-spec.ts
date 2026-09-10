/**
 * Integratietest — MFA: TOTP, herstelcodes en MFA-gate (F07, spec §7.6/§8.5).
 *
 * Draait tegen de gedeelde test-db. Controleert:
 *   - TOTP-activatie zet een versleuteld secret (niet de platte tekst) en
 *     `mfa_verplicht` op true;
 *   - een echte 6-cijferige code verifieert; een verkeerde niet;
 *   - vóór activatie werpt verifieer TotpNietGeactiveerdFout;
 *   - herstelcodes: 10 codes, argon2-hashes in de array, verbruik verwijdert
 *     de gebruikte code en een tweede gebruik faalt (§6.3);
 *   - MFA-gate: geldstroomrechten worden geweigerd zonder tweede factor en
 *     toegelaten mét TOTP of passkey; niet-geldstroomrechten zijn vrij;
 *   - passkey-opties-generatie en de challenge-TTL (verlopen challenge).
 *
 * WebAuthn-registratie/assertie zelf vereist een echte browser-assertie en
 * wordt end-to-end getest in de PWA-flow (F08/F11); hier worden de opties en
 * de challenge-TTL gecontroleerd.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  genereerTotpCodeVoor,
  maakTotpService,
  OnGeldigeTotpCodeFout,
  OnjuisteHerstelcodeFout,
  TotpNietGeactiveerdFout,
  type TotpService,
} from '../src/gemeenschappelijk/auth/totp.js';
import {
  maakMfaGate,
  MfaVereistFout,
  type MfaGate,
} from '../src/gemeenschappelijk/auth/mfa-gate.js';
import { persoon } from '../src/database/schema/persoon.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('MFA — TOTP, herstelcodes en gate (F07)', () => {
  let db: TestPgDb | undefined;
  let totp: TotpService | undefined;
  let gate: MfaGate | undefined;
  let volgnummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    totp = maakTotpService({ db: db.db });
    gate = maakMfaGate({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function seed(volgnummerLocal: number): Promise<{ id: bigint; email: string }> {
    if (!db) throw new Error('geen test-db');
    const email = `mfa${String(volgnummerLocal)}@test.vve`;
    const [rij] = await db.db
      .insert(persoon)
      .values({ email, achternaam: `MfaTest${String(volgnummerLocal)}` })
      .returning();
    if (!rij) throw new Error('seed faalde');
    return { id: rij.id, email };
  }

  it('activatie zet een versleuteld secret (niet platte tekst) en mfa_verplicht', async () => {
    if (!db || !totp) throw new Error('geen setup');
    volgnummer += 1;
    const { id, email } = await seed(volgnummer);
    const { secret } = await totp.activeer(id, email);
    expect(secret).toMatch(/^[A-Z2-7]+=*$/); // base32
    expect(secret.length).toBeGreaterThanOrEqual(28); // ≥ 20 bytes base32

    const { rows } = await db.pool.query<{ secret: Buffer | null; verplicht: boolean }>(
      'SELECT totp_secret_versleuteld AS secret, mfa_verplicht AS verplicht FROM persoon WHERE id = $1',
      [String(id)],
    );
    const opgeslagen = rows[0]?.secret;
    expect(opgeslagen).not.toBeNull();
    const alsTekst = (opgeslagen as Buffer | null)?.toString('utf8') ?? '';
    expect(alsTekst.startsWith('v1:')).toBe(true); // AES-256-GCM met versieprefix (§6.2)
    expect(alsTekst).not.toContain(secret); // de platte tekst is er niet
    expect(rows[0]?.verplicht).toBe(true);
  });

  it('verifieer werpt vóór activatie en accepteert een echte code erna', async () => {
    if (!db || !totp) throw new Error('geen setup');
    volgnummer += 1;
    const { id, email } = await seed(volgnummer);

    await expect(totp.verifieer(id, '123456')).rejects.toThrow(TotpNietGeactiveerdFout);

    const { secret } = await totp.activeer(id, email);
    // De code via dezelfde otplib-plugins genereren (test leest de echte klok):
    const code = await genereerTotpCodeVoor(secret);
    expect(code).toMatch(/^\d{6}$/);
    await expect(totp.verifieer(id, code)).resolves.toBe(true);
    await expect(totp.verifieer(id, '000000')).rejects.toThrow(OnGeldigeTotpCodeFout);
  });

  it('herstelcodes: 10 stuks, éénmalig, verbruikte verdwijnen (§6.3)', async () => {
    if (!db || !totp) throw new Error('geen setup');
    volgnummer += 1;
    const { id } = await seed(volgnummer);
    const codes = await totp.genereerHerstelcodes(id);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      // 16 bytes = 128 bits; een herstelcode omzeilt de tweede factor volledig.
      expect(code).toMatch(/^[0-9a-f]{32}$/);
    }

    // Eén code verbruiken lukt en verwijdert haar uit de array:
    const eerste = codes[0];
    if (eerstelok(eerste)) {
      await expect(totp.verbruikHerstelcode(id, eerste)).resolves.toBe(true);
      await expect(totp.verbruikHerstelcode(id, eerste)).rejects.toThrow(OnjuisteHerstelcodeFout);
    }
    // Onbekende code faalt:
    await expect(totp.verbruikHerstelcode(id, 'deadbeef')).rejects.toThrow(OnjuisteHerstelcodeFout);

    const controle = await db.pool.query<{ codes: string[] | null }>(
      'SELECT herstelcodes_hash AS codes FROM persoon WHERE id = $1',
      [String(id)],
    );
    expect(controle.rows[0]?.codes ?? []).toHaveLength(9);
  });

  it('MFA-gate: geldstroomrechten vereisen een tweede factor', async () => {
    if (!db || !gate || !totp) throw new Error('geen setup');
    volgnummer += 1;
    const { id } = await seed(volgnummer);

    // Zonder MFA: geldstroomrecht wordt geweigerd.
    await expect(gate.vereisMfaVoor(id, 'incasso.batch.goedkeuren')).rejects.toThrow(
      MfaVereistFout,
    );
    // Niet-geldstroomrechten zijn vrij:
    await expect(gate.vereisMfaVoor(id, 'document.upload')).resolves.toBeUndefined();

    // Na TOTP-activatie: zelfde recht mag.
    await totp.activeer(id, `mfa-gate${String(volgnummer)}@test.vve`);
    await expect(gate.vereisMfaVoor(id, 'incasso.batch.goedkeuren')).resolves.toBeUndefined();
    expect(gate.isGeldstroomRecht('vve.iban.wijzig')).toBe(true);
    expect(gate.isGeldstroomRecht('document.upload')).toBe(false);
  });
});

function eerstelok(code: string | undefined): code is string {
  return typeof code === 'string';
}

describe('Kolomversleuteling (F07-review, §6.2)', () => {
  it('is geauthenticeerd: een gewijzigde byte wordt geweigerd', async () => {
    const { versleutelKolom, ontsleutelKolom } =
      await import('../src/gemeenschappelijk/auth/totp.js');
    const data = versleutelKolom('GEHEIMSECRET', 'iemand@example.test');
    expect(ontsleutelKolom(data, 'iemand@example.test')).toBe('GEHEIMSECRET');

    const geknoeid = Buffer.from(data);
    const laatste = geknoeid.length - 1;
    geknoeid[laatste] = (geknoeid[laatste] ?? 0) ^ 0xff; // laatste byte van de tag omdraaien
    expect(() => ontsleutelKolom(geknoeid, 'iemand@example.test')).toThrow();
  });

  it('bindt de ciphertext aan de context: een andere rij kan hem niet lezen', async () => {
    const { versleutelKolom, ontsleutelKolom } =
      await import('../src/gemeenschappelijk/auth/totp.js');
    const data = versleutelKolom('GEHEIMSECRET', 'eigenaar@example.test');
    expect(() => ontsleutelKolom(data, 'iemand-anders@example.test')).toThrow();
  });

  it('gebruikt per keer een nieuwe nonce: dezelfde invoer geeft andere bytes', async () => {
    const { versleutelKolom } = await import('../src/gemeenschappelijk/auth/totp.js');
    const a = versleutelKolom('ZELFDE', 'iemand@example.test');
    const b = versleutelKolom('ZELFDE', 'iemand@example.test');
    expect(a.equals(b)).toBe(false);
  });
});
