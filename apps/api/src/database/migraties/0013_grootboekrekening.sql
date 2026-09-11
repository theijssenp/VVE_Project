-- 0013 — Grootboekrekeningen (spec §6.7, blok G01).
--
-- Per VvE een eigen rekeningplan (AC9.1): bij het aanmaken van de VvE wordt
-- het standaard schema uit §5.7 gekopieerd, daarna per VvE aanpasbaar.
-- `verdeelsleutel_id` bestaat nog niet (G03); die FK komt mee in de migratie
-- van G03 zelf, zodat 0013 nu de rest al compleet neemt.
--
-- RLS: tenant-tabel, patroon 0003/0010/0012. Grants via de default privileges
-- van 0004.

CREATE TABLE grootboekrekening (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint              NOT NULL REFERENCES vve(id),
  nummer            text                NOT NULL,
  naam              text                NOT NULL,
  categorie         grootboek_categorie NOT NULL,
  is_reservefonds   boolean             NOT NULL DEFAULT false,
  actief            boolean             NOT NULL DEFAULT true,
  UNIQUE (vve_id, nummer)
);

CREATE INDEX ix_gboek_vve ON grootboekrekening (vve_id);

ALTER TABLE grootboekrekening ENABLE ROW LEVEL SECURITY;
ALTER TABLE grootboekrekening FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON grootboekrekening
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);