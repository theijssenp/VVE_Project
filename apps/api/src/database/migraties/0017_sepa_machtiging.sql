-- 0017 — SEPA-machtiging met versleuteld IBAN (spec §6.2, §6.5, blok B01).
--
-- De eerste tabel met het §6.2-drieluik (versleuteld ‖ hmac ‖ masker ‖
-- sleutel_versie): een databasedump is geen betaalgegevenslijst. De
-- sleutels leven in de omgeving (IBAN_VERSLEUTEL_SLEUTEL, IBAN_HMAC_SLEUTEL),
-- nooit in de database; de sleutelversie maakt rotatie zonder downtime
-- mogelijk (de rotatietaak zelf is het laatste deel van dit blok).
--
-- BIC, tenaamstelling, kenmerk en statusvelden volgen de spec-letter.
-- `machtigingstekst_hash` (AC8.2: bewijsvastlegging digitale machtiging)
-- volgt in I02; de kolom is er al.
--
-- RLS: tenant-tabel, patroon 0003/…/0016.

CREATE TABLE sepa_machtiging (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id                bigint            NOT NULL REFERENCES vve(id),
  wooneenheid_id        bigint            NOT NULL REFERENCES wooneenheid(id),
  persoon_id            bigint            NOT NULL REFERENCES persoon(id),
  kenmerk               text              NOT NULL,
  iban_versleuteld      bytea             NOT NULL,
  iban_hmac             bytea             NOT NULL,
  iban_masker           text              NOT NULL,
  sleutel_versie        smallint          NOT NULL DEFAULT 1,
  bic                   text,
  tenaamstelling        text              NOT NULL,
  type                  machtiging_type   NOT NULL DEFAULT 'CORE',
  ondertekend_op        date              NOT NULL,
  ondertekend_ip        inet,
  machtigingstekst_hash char(64),
  eerste_incasso_gedaan boolean           NOT NULL DEFAULT false,
  vorig_kenmerk         text,
  vorig_iban_masker     text,
  vorig_incassant_id    text,
  status                machtiging_status NOT NULL DEFAULT 'actief',
  storno_teller         smallint          NOT NULL DEFAULT 0,
  ingetrokken_op        date,
  UNIQUE (vve_id, kenmerk)
);

CREATE INDEX ix_machtiging_iban ON sepa_machtiging (iban_hmac);
CREATE INDEX ix_machtiging_vve ON sepa_machtiging (vve_id);

ALTER TABLE sepa_machtiging ENABLE ROW LEVEL SECURITY;
ALTER TABLE sepa_machtiging FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON sepa_machtiging
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);