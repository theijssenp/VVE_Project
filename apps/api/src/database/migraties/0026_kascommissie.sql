-- 0026 — Kascommissie-verklaring (blok B10, spec §9 · AC9.7).
--
-- De kascommissie controleert het afgelopen boekjaar en tekent af. Die
-- verklaring is een stuk waar de ALV op vertrouwt, dus hij hoort vastgelegd te
-- worden en niet als losse notitie rond te zwerven.
--
-- Eén verklaring per commissielid per boekjaar: twee leden die los van elkaar
-- aftekenen is de normale gang van zaken, hetzelfde lid dat tweemaal tekent
-- niet.

CREATE TABLE kascommissie_verklaring (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  boekjaar_id   bigint      NOT NULL REFERENCES boekjaar(id) ON DELETE CASCADE,
  persoon_id    bigint      NOT NULL REFERENCES persoon(id),
  -- Akkoord of niet: een kascommissie die bezwaren heeft, tekent níet blind af.
  -- Daarom een expliciete vlag naast de tekst, zodat de ALV het verschil ziet
  -- zonder de bevindingen te hoeven lezen.
  akkoord       boolean     NOT NULL,
  bevindingen   text,
  getekend_op   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (boekjaar_id, persoon_id)
);

CREATE INDEX ix_kascommissie_boekjaar ON kascommissie_verklaring (boekjaar_id);

ALTER TABLE kascommissie_verklaring ENABLE ROW LEVEL SECURITY;
ALTER TABLE kascommissie_verklaring FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON kascommissie_verklaring
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

GRANT SELECT, INSERT, UPDATE, DELETE ON kascommissie_verklaring TO vve_app;
GRANT SELECT ON kascommissie_verklaring TO vve_platform;
