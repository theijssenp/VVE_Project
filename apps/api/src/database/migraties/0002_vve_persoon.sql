-- 0002 — Kern en identiteit: tabellen vve en persoon (spec §6.3).
--
-- Alleen voorwaarts. De kolomnamen zijn Nederlands, bedragen zijn bigint in centen,
-- kalenderdata is date en tijdstempels zijn timestamptz (spec §6.3). Het Drizzle-schema
-- (src/database/schema/vve.ts en persoon.ts) moet exact met dit DDL overeenkomen.
--
-- Enum's en extensies bestaan al (migratie 0001). Geen RLS in dit blokket (F04).

-- ---------------------------------------------------------------------------
-- vve — de vereniging zelf
-- ---------------------------------------------------------------------------
CREATE TABLE vve (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  naam                 text        NOT NULL,
  kvk_nummer           text        UNIQUE,
  straat               text,
  huisnummer            text,
  postcode              text,
  plaats                text,
  splitsingsdatum       date,
  modelreglement        modelreglement,
  breukdeel_noemer      integer     NOT NULL DEFAULT 1000 CHECK (breukdeel_noemer > 0),
  boekjaar_startmaand   smallint    NOT NULL DEFAULT 1 CHECK (boekjaar_startmaand BETWEEN 1 AND 12),
  herbouwwaarde_cent    bigint      CHECK (herbouwwaarde_cent >= 0),
  iban_exploitatie      text,
  iban_reserve          text,
  incassant_id          text,                          -- SEPA Creditor Identifier
  logo_document_id      bigint,
  betaaltermijn_dagen   smallint    NOT NULL DEFAULT 14,
  status                vve_status  NOT NULL DEFAULT 'actief',
  aangemaakt_op         timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op          timestamptz
);

-- ---------------------------------------------------------------------------
-- persoon — gebruiker (eigenaar/bewoner/bestuur) en account
-- ---------------------------------------------------------------------------
CREATE TABLE persoon (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                       citext      NOT NULL UNIQUE,
  wachtwoord_hash             text,                       -- argon2id
  voorletters                 text,
  voornaam                    text,
  tussenvoegsel               text,
  achternaam                  text        NOT NULL,
  telefoon                    text,
  corr_straat                 text,
  corr_huisnummer             text,
  corr_postcode               text,
  corr_plaats                 text,
  corr_land                   char(2)     NOT NULL DEFAULT 'NL',
  communicatie_wijze          communicatie_wijze  NOT NULL DEFAULT 'email',
  is_applicatiebeheerder      boolean     NOT NULL DEFAULT false,
  wachtwoord_wijzigen_verplicht boolean   NOT NULL DEFAULT false,
  wachtwoord_verloopt_op      timestamptz,
  mfa_verplicht               boolean     NOT NULL DEFAULT false,
  totp_secret_versleuteld     bytea,
  herstelcodes_hash           text[],                      -- argon2id per code, verbruikte worden verwijderd
  mislukte_pogingen           smallint    NOT NULL DEFAULT 0,
  geblokkeerd_tot             timestamptz,
  laatste_login_op            timestamptz,
  actief                      boolean     NOT NULL DEFAULT true,
  aangemaakt_op               timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op                timestamptz
);
