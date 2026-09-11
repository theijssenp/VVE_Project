-- 0015 — Verdeelsleutels (spec §6.5, blok G03).
--
-- Vijf typen (§6.1): breukdeel, vierkante_meters, gelijke_delen, stemmen,
-- handmatig. De regels hangen aan een sleutel met een gewicht (AC4.2: 0 =
-- uitgesloten). `versie` is de historisering (AC4.5): een wijziging na
-- vaststelling maakt een nieuwe rij met versie+1 en zet de oude op
-- actief = false — reeds gegenereerde nota's veranderen nooit met
-- terugwerkende kracht.
--
-- Tevens: de `verdeelsleutel_id`-FK op `grootboekrekening` (spec §6.7) die
-- G01 bewust heeft overgelaten aan deze migratie — de FK-target-tabel
-- bestond toen nog niet. AC4.3: elke begrotingsregel verwijst naar precies
-- één verdeelsleutel; de verwijzing van rekening naar sleutel is de
-- omgekeerde richting (§6.7-letter) en blijft hier optioneel.

CREATE TABLE verdeelsleutel (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id       bigint              NOT NULL REFERENCES vve(id),
  naam         text                NOT NULL,
  type         verdeelsleutel_type NOT NULL,
  versie       smallint            NOT NULL DEFAULT 1,
  actief       boolean             NOT NULL DEFAULT true,
  omschrijving text
);

CREATE TABLE verdeelsleutel_regel (
  id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verdeelsleutel_id bigint        NOT NULL REFERENCES verdeelsleutel(id) ON DELETE CASCADE,
  wooneenheid_id    bigint        NOT NULL REFERENCES wooneenheid(id),
  gewicht           numeric(14,4) NOT NULL DEFAULT 0 CHECK (gewicht >= 0),
  UNIQUE (verdeelsleutel_id, wooneenheid_id)
);

CREATE INDEX ix_vsleutel_vve ON verdeelsleutel (vve_id);
CREATE INDEX ix_vsleutel_regel ON verdeelsleutel_regel (verdeelsleutel_id);

ALTER TABLE grootboekrekening
  ADD COLUMN verdeelsleutel_id bigint REFERENCES verdeelsleutel(id);

-- ---------------------------------------------------------------------------
-- RLS — patroon 0003/0010/0012/0013
-- ---------------------------------------------------------------------------
ALTER TABLE verdeelsleutel ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdeelsleutel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON verdeelsleutel
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE verdeelsleutel_regel ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdeelsleutel_regel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON verdeelsleutel_regel
  USING      (EXISTS (
    SELECT 1 FROM verdeelsleutel s
     WHERE s.id = verdeelsleutel_regel.verdeelsleutel_id
       AND s.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM verdeelsleutel s
     WHERE s.id = verdeelsleutel_regel.verdeelsleutel_id
       AND s.vve_id = current_setting('app.vve_id')::bigint
  ));