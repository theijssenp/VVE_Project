-- 0005 — Apparatsessies en roltoewijzing (spec §6.3, blok F06b).
--
-- Alleen voorwaarts. De tabel- en kolomnamen zijn exact volgens §6.3.
-- Enum's en extensies bestaan al (migratie 0001).
--
-- apparaat_sessie: één rij per apparaat met roterende refresh tokens.
--   familie_id:     elke geefTokensUit-aanroep krijgt een nieuw uuid;
--                   alle sessies van dezelfde persoon die op hetzelfde
--                   moment werden aangemaakt delen dezelfde familie_id.
--                   Bij hergebruik van een refresh token (een reeds
--                   ingewisseld token wordt opnieuw voorgesteld) wordt de
--                   hele familie ingetrokken — dat is de kern van
--                   hergebruikdetectie (spec §7.6, §11 test #35).
--   refresh_token_hash:   sha256 hex (char(64)), UNIQUE — het ruwe token
--                   verlaat de database nooit (spec §8.2).
--   vorige_token_hash:    de hash van de refresh-token die vóór de vorige
--                   rotatie op deze row stond. Bij een hergebruik-aanbod
--                   van een token dat overeenkomt met een actieve
--                   vorige_token_hash wordt de familie ingetrokken.
--   ingetrokken_op / intrekking_reden: NULL terwijl de sessie actief is;
--                   gevuld wanneer de sessie (of een familie-maat) wordt
--                   ingetrokken.
--
-- apparatsessie is géén tenant-tabel (geen vve_id-kolom, §6.3). RLS-beleid
-- op vve_id is dus niet van toepassing. Per §6.9 gelden de default-privileges
-- van migratie 0004 al (GRANT SELECT, INSERT, UPDATE, DELETE op alle
-- tabellen IN SCHEMA public TO vve_app), dus hier hoeft niets extra's.
--
-- rol_toewijzing: koppelt een persoon aan een rol binnen een VvE, eventueel
-- tijdsgebonden (start_datum / eind_datum). Verwijst naar vve en persoon
-- (bestaan al sinds migratie 0002).

-- ---------------------------------------------------------------------------
-- rol_toewijzing — rol binnen een VvE, optioneel tijdsgebonden
-- ---------------------------------------------------------------------------
CREATE TABLE rol_toewijzing (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint   NOT NULL REFERENCES vve(id),
  persoon_id    bigint   NOT NULL REFERENCES persoon(id),
  rol           rol_type NOT NULL,
  start_datum   date     NOT NULL,
  eind_datum    date,
  aangemaakt_op timestamptz NOT NULL DEFAULT now(),
  CHECK (eind_datum IS NULL OR eind_datum >= start_datum)
);
CREATE INDEX ix_rol_vve_persoon ON rol_toewijzing (vve_id, persoon_id);

-- ---------------------------------------------------------------------------
-- apparaat_sessie — sessie van de mobiele app / PWA
-- ---------------------------------------------------------------------------
CREATE TABLE apparaat_sessie (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persoon_id          bigint      NOT NULL REFERENCES persoon(id) ON DELETE CASCADE,
  familie_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  refresh_token_hash  char(64)    NOT NULL UNIQUE,
  vorige_token_hash   char(64),
  platform            text,
  apparaat_naam       text,
  ip_laatste          inet,
  user_agent          text,
  verloopt_op         timestamptz NOT NULL,
  ingetrokken_op      timestamptz,
  intrekking_reden    text,
  laatst_gebruikt_op     timestamptz,
  aangemaakt_op       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessie_persoon ON apparaat_sessie (persoon_id) WHERE ingetrokken_op IS NULL;
CREATE INDEX ix_sessie_familie ON apparaat_sessie (familie_id);
