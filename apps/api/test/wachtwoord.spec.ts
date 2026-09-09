import { describe, expect, it } from 'vitest';

import {
  beoordeelWachtwoord,
  HASH_PARAMS,
  hashWachtwoord,
  MOINSTE_LENGTE,
  verifieerWachtwoord,
} from '../src/gemeenschappelijk/auth/wachtwoord.js';

// F06a — wachtwoord-primitives (spec §7.6, §8.2).
//
// Alleen deterministische gedragstests: géén timing-asserts (die zijn broos),
// géén db, géén netwerk. `hashWachtwoord`/`verifieerWachtwoord` doen wel
// native work (argon2), maar dat is geen deterministiek-probleem voor de
// functionaliteit die hier wordt geverifieerd.

describe('auth/wachtwoord — F06a (spec §7.6, §8.2)', () => {
  describe('HASH_PARAMS', () => {
    it('is een argon2id-configuratie met de OWASP 2023-baselines', () => {
      // memoryCost is in KiB; 19 MiB = 19 × 1024.
      expect(HASH_PARAMS.memoryCost).toBe(19 * 1024);
      expect(HASH_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
      expect(HASH_PARAMS.parallelism).toBe(1);
      expect(HASH_PARAMS.type).toBeDefined();
    });
  });

  describe('hashWachtwoord + verifieerWachtwoord', () => {
    it('produceert geen platte tekst', async () => {
      const tekst = 'een-stark-wachtwoord-xyz';
      const hash = await hashWachtwoord(tekst);
      expect(hash).not.toBe(tekst);
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });

    it('produceert per invoer een unieke hash (verschillende salt, zelfde wachtwoord)', async () => {
      const hash1 = await hashWachtwoord('een-stark-wachtwoord');
      const hash2 = await hashWachtwoord('een-stark-wachtwoord');
      // Zelfde wachtwoord, verschillende salt → verschillende output.
      expect(hash1).not.toBe(hash2);
    });

    it('verifieert het goede wachtwoord correct', async () => {
      const tekst = 'een-stark-wachtwoord-xyz';
      const hash = await hashWachtwoord(tekst);
      expect(await verifieerWachtwoord(tekst, hash)).toBe(true);
    });

    it('wijst een verkeerd wachtwoord af', async () => {
      const tekst = 'een-stark-wachtwoord-xyz';
      const hash = await hashWachtwoord(tekst);
      expect(await verifieerWachtwoord('een-andere-tekt-xyz', hash)).toBe(false);
    });

    it('verifieert correct tegen een hash van een ander wachtwoord (geen false-positive)', async () => {
      const hashA = await hashWachtwoord('wachtwoord-A-123456');
      const hashB = await hashWachtwoord('wachtwoord-B-654321');
      expect(await verifieerWachtwoord('wachtwoord-A-123456', hashA)).toBe(true);
      expect(await verifieerWachtwoord('wachtwoord-B-654321', hashB)).toBe(true);
      // Cross-check: A tegen B-hashing werkt niet, en omgekeerd evenmin.
      expect(await verifieerWachtwoord('wachtwoord-B-654321', hashA)).toBe(false);
      expect(await verifieerWachtwoord('wachtwoord-A-123456', hashB)).toBe(false);
    });

    it('codeert de argon2id-parameters mee in de PHC-string (zodat een hash overleeft na een parameter-bump)', async () => {
      const hash = await hashWachtwoord('a');
      expect(hash.startsWith('$argon2id$')).toBe(true);
       // De gebruikte parameters staan in de PHC-string, zodat een hash ook na
      // een toekomstige wijziging van HASH_PARAMS nog verifieerbaar is. De
      // exacte volgorde (m=,p=,t=) hangt af van de argon2-implementatie en
      // is niet normatief, dus testen we de onderdelen los i.p.v. één regex.
      expect(hash).toContain('m=19456');
      expect(hash).toContain('t=2');
      expect(hash).toContain('p=1');
     });
  });

  describe('verifieerWachtwoord — corrupte/ongeldige hash → false (geen crash)', () => {
    it('geeft false terug voor een lege string', async () => {
      expect(await verifieerWachtwoord('toestel', '')).toBe(false);
    });

    it('geeft false terug voor een string die niet een argon2-hash is', async () => {
      expect(await verifieerWachtwoord('toestel', 'niet-een-hash')).toBe(false);
    });

    it('geeft false terug voor een partially-formaatteerde argon2-string', async () => {
      // Geldig voorpref maar afgekorte payload: onparseerbaar, dus false.
      const corrupt = '$argon2id$v=19$m=1024,t=2,p=1$';
      expect(await verifieerWachtwoord('toestel', corrupt)).toBe(false);
    });

    it('geeft false terug voor een hash van een ander type (argon2i, niet argon2id)', async () => {
      // Het is een geldige argon2-string maar niet het type dat we hashen.
      const argon2i =
        '$argon2i$v=19$m=10240,t=2,p=1$c2FsdF9kZW0vZGVt$8f4e7c1a0d1e9b3c7a4f6e8d0c1b2a3f';
      // verifieerWachtwoord hoeft niet te weten dat dit een ander type is —
      // het moet alleen niet crashen en niet false-posen.
      expect(await verifieerWachtwoord('toestel', argon2i)).toBe(false);
    });
  });

  describe('beoordeelWachtwoord — sterktebeleid (spec §7.6)', () => {
    it('MOINSTE_LENGTE is 12', () => {
      expect(MOINSTE_LENGTE).toBe(12);
    });

    it('accepteert een sterk wachtwoord ("correcte paardenspringer batterij")', () => {
      const r = beoordeelWachtwoord('correcte paardenspringer batterij');
      expect(r.ok).toBe(true);
      expect(r.redenen).toEqual([]);
    });

    it('weigert "welkom123" (veelgebruikte stam)', () => {
      const r = beoordeelWachtwoord('welkom123');
      expect(r.ok).toBe(false);
      expect(r.redenen.length).toBeGreaterThan(0);
    });

    it('weigert een kort wachtwoord (11 tekens)', () => {
      const r = beoordeelWachtwoord('12345678901'); // 11 tekens, geen triviaal patroon
      expect(r.ok).toBe(false);
      expect(r.redenen.some((s) => /te kort/.test(s))).toBe(true);
    });

    it('weigert 12+ tekens met een veelgebruikte kern ("123456789012")', () => {
      const r = beoordeelWachtwoord('123456789012');
      expect(r.ok).toBe(false);
    });

    it('weigert 12+ tekens met een veelgebruikte kern ("welkom123456")', () => {
      const r = beoordeelWachtwoord('welkom123456');
      expect(r.ok).toBe(false);
    });

    it('accepteert een 12-tekens wachtwoord zonder bekend patroon', () => {
      // "Xy7k-z9m-qv3!" — 12 tekens, geen triviaal patroon, niet in de zwartelijst.
      const r = beoordeelWachtwoord('Xy7k-z9m-qv3!');
      expect(r.ok).toBe(true);
      expect(r.redenen).toEqual([]);
    });

    it('geeft een leesbare reden bij een te kort wachtwoord', () => {
      const r = beoordeelWachtwoord('abc');
      expect(r.ok).toBe(false);
      expect(r.redenen.some((s) => /te kort/.test(s))).toBe(true);
    });

    it('geeft een leesbare reden bij een veelgebruikt wachtwoord', () => {
      const r = beoordeelWachtwoord('password');
      expect(r.ok).toBe(false);
      expect(r.redenen.some((s) => /veelgebruikt|triviaal/i.test(s))).toBe(true);
    });

    it('combineert redenen: kort alleen, triviaal alleen, en kort-én-triviaal samen', () => {
       // "abc": 3 tekens → alleen "te kort" (niet triviaal) → 1 reden.
      const r1 = beoordeelWachtwoord('abc');
      expect(r1.redenen.length).toBe(1);
       // "welkom123456": 14 tekens (≥12, dus niet kort) maar kwetsbare stam
      // "welkom" → alleen "veelgebruikt/triviaal" → 1 reden.
      const r2 = beoordeelWachtwoord('welkom123456');
      expect(r2.redenen.length).toBe(1);
       // "welkom123": 9 tekens (<12, kort) ÉN kwetsbare stam → twee redenen.
      const r3 = beoordeelWachtwoord('welkom123');
      expect(r3.redenen.length).toBe(2);
     });

    it('weigert naam-plus-jaar patronten ("vve2026", "janssen1995")', () => {
      expect(beoordeelWachtwoord('vve2026').ok).toBe(false);
    });
  });
});
