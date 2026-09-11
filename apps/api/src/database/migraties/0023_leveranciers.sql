-- 0023 — Leveranciers en verplichtingenregister (spec §6.9, M12 ·
-- AC12.4–AC12.6, blok A05).
--
-- `leverancier`: contactgegevens + IBAN (§6.2-drieluik, als bij eigenaren),
-- KvK. `leverancier_contract`: looptijd + opzegtermijn → de
-- opzegsignalering (AC12.4: 90 dagen vóór verstrijken) is *live* gerekend.
-- `verplichting`: keuringen/verzekeringen (AC12.5) met vervaldatum en
-- herinneringen op T-60 en T-14.
--
-- Facturen (AC12.6) hangen aan leverancier + grootboekrekening en kunnen aan
-- een MJOP-activiteit of melding koppelen — die kolommen volgen in M01/A04
-- (vooruitverwijzing bewust open: nullable).
--
-- IBAN op leverancier is een apart veld per leverancier (één per
-- leverancier), versleuteld met de §6.2-drieluik (B01-module hergebruikt).
--
-- `verplichting_soort` bestaat al (0001, §6.1-hoofdlijst met de volledige
-- soortenlijst: liftkeuring, brandmeldinstallatie, legionella, nen3140,
-- opstalverzekering, aansprakelijkheid, bestuurdersaansprakelijkheid,
-- rechtsbijstand, energielabel, overig) — G08-les: gecheckt vóór 0023.

CREATE TABLE leverancier (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint  NOT NULL REFERENCES vve(id),
  naam               text    NOT NULL,
  contactpersoon     text,
  email              text,
  telefoon           text,
  iban_versleuteld   bytea,
  iban_hmac          bytea,
  iban_masker        text,
  sleutel_versie     smallint NOT NULL DEFAULT 1,
  kvk_nummer         text,
  opmerking          text,
  aangemaakt_op      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leverancier_contract (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint  NOT NULL REFERENCES vve(id),
  leverancier_id   bigint  NOT NULL REFERENCES leverancier(id) ON DELETE CASCADE,
  omschrijving     text    NOT NULL,
  bedrag_per_jaar_cent bigint NOT NULL CHECK (bedrag_per_jaar_cent >= 0),
  start_datum      date    NOT NULL,
  eind_datum       date,
  opzegtermijn_dagen int   NOT NULL DEFAULT 60,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verplichting (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint        NOT NULL REFERENCES vve(id),
  leverancier_id   bigint        REFERENCES leverancier(id),
  soort            verplichting_soort NOT NULL,
  omschrijving     text          NOT NULL,
  vervaldatum      date          NOT NULL,
  polis_document_id bigint,
  aangemaakt_op    timestamptz   NOT NULL DEFAULT now(),
  CHECK (vervaldatum > '1900-01-01')
);

CREATE INDEX ix_contract_eind ON leverancier_contract (vve_id, eind_datum);
CREATE INDEX ix_verplichting_verval ON verplichting (vve_id, vervaldatum);

ALTER TABLE leverancier ENABLE ROW LEVEL SECURITY;
ALTER TABLE leverancier FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON leverancier
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE leverancier_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE leverancier_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON leverancier_contract
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE verplichting ENABLE ROW LEVEL SECURITY;
ALTER TABLE verplichting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON verplichting
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);