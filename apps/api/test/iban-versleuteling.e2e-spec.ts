/**
 * Integratietest — IBAN-versleuteling en SEPA-machtiging (B01, spec §6.2).
 *
 * Controleert:
 *   - AES-256-GCM: versleuteld/ontsleuteld is identiek; nonce ‖ ct ‖ tag-vorm;
 *     twee versleutelingen van hetzelfde IBAN verschillen (willekeurige nonce);
 *   - ontsleutelen met een verkeerde sleutel → OnjuisteSleutelFout;
 *   - HMAC is deterministisch, ongeacht groeperingstekens/case (normalisatie);
 *   - masker `NL91 **** **** 1234`;
 *   - IBAN-mod-97: geldige NL-IBAN doorstaat, fout checksum faalt;
 *   - sleutels uit de omgeving zijn verplicht (geen standaardwaarde, §8.2);
 *   - de machtigingstabel neemt het drieluik en de HMAC is indexeerbaar
 *     (zoek op HMAC vindt de rij zonder ontsleutelen).
 */

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  beveiligIban,
  ibanHmac,
  ibanMasker,
  isGeldigIban,
  laadIbanSleutels,
  normaliseerIban,
  ontsleutelIban,
  versleutelIban,
  IbanSleutels,
  OnjuisteSleutelFout,
  OngeldigIbanFout,
  SleutelOntbreektFout,
} from '../src/bank/iban-versleuteling.js';
import { persoon, sepaMachtiging, vve, wooneenheid } from '../src/database/schema/index.js';
import { gedeeldeTestDb } from './testcontainers.js';

const GELDIG_IBAN = 'NL91 ABNA 0417 1643 00';
let sleutels: IbanSleutels | undefined;

describe('IBAN-versleuteling (B01, §6.2)', () => {
  beforeAll(() => {
    process.env['IBAN_VERSLEUTEL_SLEUTEL'] = 'b'.repeat(64); // hex, 32 bytes
    process.env['IBAN_HMAC_SLEUTEL'] = 'c'.repeat(64);
    sleutels = laadIbanSleutels();
  });

  it('versleutelt en ontsleutelt rond; nonce is willekeurig', () => {
    if (!sleutels) throw new Error('geen sleutels');
    const a = versleutelIban(GELDIG_IBAN, sleutels);
    const b = versleutelIban(GELDIG_IBAN, sleutels);
    expect(a).not.toEqual(b); // willekeurige nonce per versleuteling
    expect(ontsleutelIban(a, sleutels)).toBe(normaliseerIban(GELDIG_IBAN));
    expect(ontsleutelIban(b, sleutels)).toBe(normaliseerIban(GELDIG_IBAN));
  });

  it('weigert ontsleutelen met een verkeerde sleutel', () => {
    if (!sleutels) throw new Error('geen sleutels');
    const verkeerd: IbanSleutels = {
      versleutelSleutel: Buffer.alloc(32, 9),
      hmacSleutel: sleutels.hmacSleutel,
    };
    const versleuteld = versleutelIban(GELDIG_IBAN, sleutels);
    expect(() => ontsleutelIban(versleuteld, verkeerd)).toThrow(OnjuisteSleutelFout);
  });

  it('HMAC is deterministisch over genormaliseerde vormen; masker volgt §6.2', () => {
    if (!sleutels) throw new Error('geen sleutels');
    expect(ibanHmac('nl91 abna 0417 1643 00', sleutels)).toEqual(ibanHmac(GELDIG_IBAN, sleutels));
    expect(ibanHmac('NL91ABNA0417164300', sleutels)).toEqual(ibanHmac(GELDIG_IBAN, sleutels));
    expect(ibanHmac('NL20 ABNA 9999 9999 99', sleutels)).not.toEqual(
      ibanHmac(GELDIG_IBAN, sleutels),
    );
    expect(ibanMasker(GELDIG_IBAN)).toBe('NL91 **** **** 4300');
  });

  it('mod-97-toets: geldig NL-IBAN slaagt, foute checksum faalt', () => {
    expect(isGeldigIban(GELDIG_IBAN)).toBe(true);
    expect(isGeldigIban('NL20 ABNA 0417 1643 00')).toBe(false); // 20 ipv 91
    expect(isGeldigIban('niet-iban')).toBe(false);
  });

  it('start niet zonder omgevingssleutels (geen standaardwaarde, §8.2)', () => {
    const vorig = process.env['IBAN_VERSLEUTEL_SLEUTEL'];
    delete process.env['IBAN_VERSLEUTEL_SLEUTEL'];
    expect(() => laadIbanSleutels()).toThrow(SleutelOntbreektFout);
    if (vorig === undefined) delete process.env['IBAN_VERSLEUTEL_SLEUTEL'];
    else process.env['IBAN_VERSLEUTEL_SLEUTEL'] = vorig;
  });

  it('weigert een ongeldig IBAN bij versleutelen', () => {
    const s = sleutels;
    if (s === undefined) throw new Error('geen sleutels');
    expect(() => versleutelIban('NL20 ABNA 0417 1643 00', s)).toThrow(OngeldigIbanFout);
    expect(() => beveiligIban('niet-iban', s)).toThrow(OngeldigIbanFout);
  });

  it('bewaart het drieluik in de machtiging; HMAC zoekt zonder ontsleutelen', async () => {
    const db = await gedeeldeTestDb();
    const n = String(Date.now());
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `B01-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `b01-${n}@test.vve`, achternaam: 'Eigenaar' })
      .returning({ id: persoon.id });
    const [e] = await db.db
      .insert(wooneenheid)
      .values({ vveId: v?.id ?? 0n, code: 'A-01' })
      .returning({ id: wooneenheid.id });
    if (v === undefined || p === undefined || e === undefined) throw new Error('seed faalde');

    if (!sleutels) throw new Error('geen sleutels');
    const drieluik = beveiligIban('NL91 ABNA 0417 1643 00', sleutels);
    const [rij] = await db.db
      .insert(sepaMachtiging)
      .values({
        vveId: v.id,
        wooneenheidId: e.id,
        persoonId: p.id,
        kenmerk: `VVE1-A-01-1`,
        ibanVersleuteld: drieluik.versleuteld,
        ibanHmac: drieluik.hmac,
        ibanMasker: drieluik.masker,
        sleutelVersie: drieluik.sleutelVersie,
        tenaamstelling: 'P. Theijssen',
        ondertekendOp: '2026-01-01',
      })
      .returning({ id: sepaMachtiging.id });
    if (rij === undefined) throw new Error('machtiging-seed faalde');

    // Zoek op HMAC (B05-pad) zonder te ontsleutelen:
    const hmac = ibanHmac('nl91abna0417164300', sleutels);
    const [gevonden] = await db.db
      .select({ masker: sepaMachtiging.ibanMasker })
      .from(sepaMachtiging)
      .where(eq(sepaMachtiging.ibanHmac, hmac))
      .limit(1);
    expect(gevonden?.masker).toBe('NL91 **** **** 4300');

    // En de dump bevat geen platte tekst: het versleutelde veld is niet leesbaar.
    const [ruw] = await db.db
      .select({ ibanVersleuteld: sepaMachtiging.ibanVersleuteld })
      .from(sepaMachtiging)
      .where(eq(sepaMachtiging.id, rij.id))
      .limit(1);
    expect((ruw?.ibanVersleuteld as unknown as Buffer).toString('utf8')).not.toContain('ABNA');
  });
});
