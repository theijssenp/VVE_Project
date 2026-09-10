-- 0006 — Passkeys (WebAuthn) en herstelcodes-historie (spec §6.3, blok F07).
--
-- De `passkey`-tabel exact volgens §6.3. De persoon-kolommen
-- (totop_secret_versleuteld, herstelcodes_hash, mfa_verplicht) bestaan al
-- sinds migratie 0002. Dit blok voegt alleen de tabel toe.
--
-- TOTP-terugval heeft géén eigen tabel: het secret staat versleuteld (bytea)
-- op `persoon.totp_secret_versleuteld` en de herstelcodes als argon2-hashes in
-- `persoon.herstelcodes_hash` (text-array, verbruikte worden verwijderd).
--
-- apparaat_sessie/rol_toewijzing bestaan al (0005). RLS: passkey is persoon-
-- gebonden, geen tenant-tabel — de default-privileges van 0004 regelen de
-- rechten voor vve_app.

-- ---------------------------------------------------------------------------
-- passkey — WebAuthn-credential per persoon
-- ---------------------------------------------------------------------------
CREATE TABLE passkey (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persoon_id         bigint      NOT NULL REFERENCES persoon(id) ON DELETE CASCADE,
  credential_id      bytea       NOT NULL UNIQUE,
  publieke_sleutel   bytea       NOT NULL,
  teller             bigint      NOT NULL DEFAULT 0,
  apparaat_naam      text,
  laatst_gebruikt_op timestamptz,
  aangemaakt_op      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_passkey_persoon ON passkey (persoon_id);