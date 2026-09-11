-- 0018 — Bijdrageschema (spec §6.5, blok G05).
--
-- Drie methoden (M5): `uit_begroting` (jaarbedrag per eenheid uit de
-- begroting via de verdeelsleutels), `vast_bedrag` (handmatige periodebedragen
-- voor een overgenomen VvE; de begroting dient alleen voor dekkingsanalyse,
-- AC5.2-dekkingstekort) en `vierkante_meters` (totaal ÷ totaal m² × m² per
-- eenheid). Elke regel van het schema draagt de exploitatie/reserve-split
-- apart (§5.3), en `bron` onderscheidt berekend van handmatig vastgelegd.
--
-- RLS: patroon 0003/…/0017; de regels volgen de moeder via EXISTS.

CREATE TABLE bijdrage_schema (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint           NOT NULL REFERENCES vve(id),
  boekjaar_id   bigint           NOT NULL REFERENCES boekjaar(id),
  methode       bijdrage_methode NOT NULL,
  periodiciteit periodiciteit     NOT NULL DEFAULT 'maand',
  ingangsdatum  date             NOT NULL,
  status        begroting_status NOT NULL DEFAULT 'concept',
  UNIQUE (boekjaar_id, ingangsdatum)
);

CREATE TABLE bijdrage_regel (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bijdrage_schema_id bigint        NOT NULL REFERENCES bijdrage_schema(id) ON DELETE CASCADE,
  wooneenheid_id     bigint        NOT NULL REFERENCES wooneenheid(id),
  exploitatie_cent   bigint        NOT NULL DEFAULT 0 CHECK (exploitatie_cent >= 0),
  reservefonds_cent  bigint        NOT NULL DEFAULT 0 CHECK (reservefonds_cent >= 0),
  bron               bijdrage_bron NOT NULL DEFAULT 'berekend',
  UNIQUE (bijdrage_schema_id, wooneenheid_id)
);

CREATE INDEX ix_bijdrage_schema_vve ON bijdrage_schema (vve_id);
CREATE INDEX ix_bijdrage_regel_schema ON bijdrage_regel (bijdrage_schema_id);

ALTER TABLE bijdrage_schema ENABLE ROW LEVEL SECURITY;
ALTER TABLE bijdrage_schema FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bijdrage_schema
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE bijdrage_regel ENABLE ROW LEVEL SECURITY;
ALTER TABLE bijdrage_regel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bijdrage_regel
  USING      (EXISTS (
    SELECT 1 FROM bijdrage_schema s
     WHERE s.id = bijdrage_regel.bijdrage_schema_id
       AND s.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM bijdrage_schema s
     WHERE s.id = bijdrage_regel.bijdrage_schema_id
       AND s.vve_id = current_setting('app.vve_id')::bigint
  ));