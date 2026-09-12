-- 0027 — Bankrekeningen, afschriftimports en bankmutaties (blok B02, §10, AC7.1–7.3).
--
-- Drie tabellen:
--   bankrekening   de eigen rekeningen van de VvE, met het §6.2-drieluik;
--   bank_import    één ingelezen bestand, met de saldi die erin stonden;
--   bankmutatie    de afzonderlijke posten.
--
-- IBAN's van tegenrekeningen zijn persoonsgegevens en gaan nooit onversleuteld
-- de database in (§6.2, kritieke volgorde "B01 vóór B02"). Vandaar per IBAN het
-- drieluik: versleuteld voor het terughalen, HMAC voor het zoeken zonder te
-- ontsleutelen, en een masker voor op het scherm.

CREATE TABLE bankrekening (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  naam              text        NOT NULL,
  iban_versleuteld  bytea       NOT NULL,
  iban_hmac         bytea       NOT NULL,
  iban_masker       text        NOT NULL,
  sleutel_versie    smallint    NOT NULL DEFAULT 1,
  -- De grootboekrekening waarop deze bankrekening boekt (1100 e.v. uit §5.7).
  grootboekrekening_id bigint   REFERENCES grootboekrekening(id),
  -- Laatst bekende eindsaldo; hierop toetst AC7.3 de continuïteit.
  laatste_saldo_cent   bigint,
  laatste_saldo_datum  date,
  actief            boolean     NOT NULL DEFAULT true,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vve_id, iban_hmac)
);

CREATE TABLE bank_import (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  bankrekening_id   bigint      NOT NULL REFERENCES bankrekening(id) ON DELETE CASCADE,
  formaat           text        NOT NULL,
  bestandsnaam      text,
  afschrift_id      text,
  beginsaldo_cent   bigint      NOT NULL,
  eindsaldo_cent    bigint      NOT NULL,
  beginsaldo_datum  date,
  eindsaldo_datum   date,
  aantal_posten     integer     NOT NULL DEFAULT 0,
  aantal_nieuw      integer     NOT NULL DEFAULT 0,
  aantal_duplicaat  integer     NOT NULL DEFAULT 0,
  -- AC7.3: een gat in de saldocontinuïteit blokkeert niet het inlezen maar
  -- wordt hier vastgelegd, zodat de beheerder ziet wat er mist en hoeveel.
  continuiteit_gat_cent bigint,
  door_persoon_id   bigint      NOT NULL REFERENCES persoon(id),
  aangemaakt_op     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bankmutatie (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  bankrekening_id   bigint      NOT NULL REFERENCES bankrekening(id) ON DELETE CASCADE,
  bank_import_id    bigint      NOT NULL REFERENCES bank_import(id) ON DELETE CASCADE,
  boekdatum         date        NOT NULL,
  valutadatum       date,
  -- Positief = bij, negatief = af. Eén veld met teken in plaats van een bedrag
  -- plus een losse richtingvlag die iemand kan vergeten mee te lezen.
  bedrag_cent       bigint      NOT NULL,
  munt              text        NOT NULL DEFAULT 'EUR',
  tegenrekening_versleuteld bytea,
  tegenrekening_hmac        bytea,
  tegenrekening_masker      text,
  tegenpartij_naam  text,
  omschrijving      text        NOT NULL DEFAULT '',
  eind_tot_eind_id  text,
  bankreferentie    text,
  volgnummer        integer     NOT NULL,
  -- AC7.2: sha256 over rekening, boekdatum, bedrag, tegenrekening,
  -- omschrijving en referentie. Uniek per VvE: hetzelfde bestand twee keer
  -- inlezen voegt niets toe, en dat is een databasegarantie en geen belofte.
  duplicaat_hash    bytea       NOT NULL,
  gematcht_op       timestamptz,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vve_id, duplicaat_hash)
);

CREATE INDEX ix_bankmutatie_rekening_datum ON bankmutatie (bankrekening_id, boekdatum);
CREATE INDEX ix_bankmutatie_tegenrekening ON bankmutatie (tegenrekening_hmac);
CREATE INDEX ix_bankmutatie_ongematcht ON bankmutatie (vve_id) WHERE gematcht_op IS NULL;

ALTER TABLE bankrekening ENABLE ROW LEVEL SECURITY;
ALTER TABLE bankrekening FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bankrekening
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE bank_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bank_import
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE bankmutatie ENABLE ROW LEVEL SECURITY;
ALTER TABLE bankmutatie FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bankmutatie
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

GRANT SELECT, INSERT, UPDATE, DELETE ON bankrekening, bank_import, bankmutatie TO vve_app;
GRANT SELECT ON bankrekening, bank_import, bankmutatie TO vve_platform;
