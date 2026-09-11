-- 0024 — Mededelingen en mailsjablonen (spec M13 · AC13.1/AC13.3, blok A06).
--
-- `mededeling`: nieuwsberichten per VvE met doelgroep (alle leden /
-- eigenaren / bewoners) en de optie om per e-mail te versturen (AC13.1) —
-- de verzending loopt via de bestaande F10-mailwachtrij.
--
-- `mail_sjabloon`: per VvE aanpasbare sjablonen (afzendernaam, ondertekening)
-- met vaste placeholders. De placeholdervervanging gebeurt in de service;
-- een sjabloonfout blokkeert het versturen nooit (AC13.3: fallback naar het
-- standaardsjabloon — hier: leeg sjabloon = standaardtekst).
--
-- RLS: patroon 0003.

CREATE TYPE mededeling_doelgroep AS ENUM ('alle_leden','eigenaren','bewoners');

CREATE TABLE mededeling (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint  NOT NULL REFERENCES vve(id),
  titel            text    NOT NULL,
  inhoud           text    NOT NULL,
  doelgroep        mededeling_doelgroep NOT NULL,
  gepubliceerd_op  timestamptz NOT NULL DEFAULT now(),
  door_persoon_id  bigint  NOT NULL REFERENCES persoon(id),
  mail_verzonden   boolean NOT NULL DEFAULT false
);

CREATE TABLE mail_sjabloon (
  vve_id           bigint  PRIMARY KEY REFERENCES vve(id),
  afzendernaam     text    NOT NULL,
  ondertekening    text,
  logo_url         text,
  gewijzigd_op     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_mededeling_vve ON mededeling (vve_id, gepubliceerd_op DESC);

ALTER TABLE mededeling ENABLE ROW LEVEL SECURITY;
ALTER TABLE mededeling FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON mededeling
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE mail_sjabloon ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_sjabloon FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON mail_sjabloon
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);