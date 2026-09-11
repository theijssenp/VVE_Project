-- 0016 — Begroting en begrotingsregels (spec §6.5, blok G04).
--
-- Één begroting per boekjaar (UNIQUE op boekjaar_id). Statusflow
-- `concept → voorgesteld_alv → vastgesteld → gesloten` (enum `begroting_status`
-- uit 0001); alleen vanuit `vastgesteld` mogen nota's worden gegenereerd
-- (AC5.1, G06 bewaakt dat). Elke regel wijst één grootboekrekening en
-- precies één verdeelsleutel aan (AC4.3) en draagt de exploitatie/reserve-
-- splitsing (§5.2: "elke begrotingsregel is gemarkeerd als reservefonds 0|1").
--
-- `besluit_id` uit de spec verwijst naar het besluitenregister (M11, blok A03)
-- en bestaat nog niet: de kolom komt met die migratie, nu bewust weggelaten
-- zodat het DDL de FK's alleen aanraakt die er zijn.
--
-- RLS: patroon 0003/0010/…; begroting is tenant-tabel, regels volgen de
-- moeder via EXISTS (zelfde vorm als boekingsregel in 0014).

CREATE TABLE begroting (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id         bigint           NOT NULL REFERENCES vve(id),
  boekjaar_id    bigint           NOT NULL UNIQUE REFERENCES boekjaar(id),
  status         begroting_status NOT NULL DEFAULT 'concept',
  vastgesteld_op date,
  besluit_id     bigint
);

CREATE TABLE begrotingsregel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  begroting_id         bigint  NOT NULL REFERENCES begroting(id) ON DELETE CASCADE,
  grootboekrekening_id bigint  NOT NULL REFERENCES grootboekrekening(id),
  omschrijving         text    NOT NULL,
  bedrag_cent          bigint  NOT NULL CHECK (bedrag_cent >= 0),
  verdeelsleutel_id    bigint  NOT NULL REFERENCES verdeelsleutel(id),
  is_reservefonds      boolean NOT NULL DEFAULT false,
  volgorde             smallint NOT NULL DEFAULT 0
);

CREATE INDEX ix_begrotingsregel_begroting ON begrotingsregel (begroting_id);

ALTER TABLE begroting ENABLE ROW LEVEL SECURITY;
ALTER TABLE begroting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON begroting
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE begrotingsregel ENABLE ROW LEVEL SECURITY;
ALTER TABLE begrotingsregel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON begrotingsregel
  USING      (EXISTS (
    SELECT 1 FROM begroting b
     WHERE b.id = begrotingsregel.begroting_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM begroting b
     WHERE b.id = begrotingsregel.begroting_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ));