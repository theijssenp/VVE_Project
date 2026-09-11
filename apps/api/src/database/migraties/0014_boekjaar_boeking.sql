-- 0014 — Boekjaar, boeking, boekingsregel (spec §6.7, blok G02).
--
-- De dubbel-boekhoudkern: `boekjaar` (status concept/open/afgesloten),
-- `boeking` (journaalpost met bronverwijzing) en `boekingsregel` (debet/
-- credit-regels op grootboekrekeningen, optioneel toegeschreven aan een
-- eenheid). Balanseis: per boeking som(debet) = som(credit), afgedwongen
-- door een CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED — het vangnet
-- onder de boekingsservice (§7.4). Boekingen zijn append-only: geen
-- UPDATE/DELETE voor de applicatierol (§7.4); alleen `vergrendeld` mag later
-- door de jaarafsluiting worden gezet (expliciet gerechtigde routine, volgt
-- in B10).

CREATE TABLE boekjaar (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint          NOT NULL REFERENCES vve(id),
  jaar          smallint        NOT NULL,
  start_datum   date            NOT NULL,
  eind_datum    date            NOT NULL,
  status        boekjaar_status NOT NULL DEFAULT 'concept',
  afgesloten_op timestamptz,
  UNIQUE (vve_id, jaar),
  CHECK (eind_datum > start_datum)
);

CREATE TABLE boeking (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id          bigint       NOT NULL REFERENCES vve(id),
  boekjaar_id     bigint       NOT NULL REFERENCES boekjaar(id),
  nummer          text         NOT NULL,
  datum           date         NOT NULL,
  omschrijving    text         NOT NULL,
  bron            boeking_bron NOT NULL,
  bron_id         bigint,
  vergrendeld     boolean      NOT NULL DEFAULT false,
  aangemaakt_door bigint       NOT NULL REFERENCES persoon(id),
  aangemaakt_op   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (vve_id, nummer)
);
CREATE INDEX ix_boeking_datum ON boeking (vve_id, datum);

CREATE TABLE boekingsregel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  boeking_id           bigint NOT NULL REFERENCES boeking(id) ON DELETE RESTRICT,
  grootboekrekening_id bigint NOT NULL REFERENCES grootboekrekening(id),
  wooneenheid_id       bigint REFERENCES wooneenheid(id),
  omschrijving         text,
  debet_cent           bigint NOT NULL DEFAULT 0 CHECK (debet_cent  >= 0),
  credit_cent          bigint NOT NULL DEFAULT 0 CHECK (credit_cent >= 0),
  CHECK ((debet_cent = 0) <> (credit_cent = 0))     -- precies één van beide gevuld
);
CREATE INDEX ix_regel_grootboek ON boekingsregel (grootboekrekening_id, boeking_id);
CREATE INDEX ix_regel_eenheid   ON boekingsregel (wooneenheid_id);

-- ---------------------------------------------------------------------------
-- Het vangnet (§6.7): per boeking moet aan het eind van de transactie de
-- som van debet gelijk zijn aan de som van credit. DEFERRED zodat de service
-- binnen één transactie eerst alles mag schrijven en pas bij COMMIT de
-- balans wordt gecontroleerd. Gebeuren er rechtstreeks inserts buiten de
-- service om, dan vangt deze trigger ze af.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION boeking_balans_controle() RETURNS trigger AS $$
BEGIN
  IF (
    SELECT coalesce(sum(debet_cent), 0) <> coalesce(sum(credit_cent), 0)
      FROM boekingsregel WHERE boeking_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'boeking % is niet in balans (debet <> credit)', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER boeking_balans_trig
  AFTER INSERT ON boeking
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION boeking_balans_controle();

-- ---------------------------------------------------------------------------
-- Append-only (§7.4): de applicatierol mag schrijven maar nooit muteren.
-- ---------------------------------------------------------------------------

-- UPDATE en DELETE zijn nooit toegestaan op de twee tabellen (default
-- privileges van 0004 gaven ze wél; hier expliciet terugnemen). Alleen de
-- vergrendelingsvlag mag later worden gezet, en uitsluitend door de
-- expliciet gerechtigde jaarafsluiting (blok B10) onder een eigen rol.
REVOKE UPDATE, DELETE ON boeking FROM vve_app;
REVOKE UPDATE, DELETE ON boekingsregel FROM vve_app;

-- ---------------------------------------------------------------------------
-- RLS — patroon 0003/0010/0012/0013
-- ---------------------------------------------------------------------------
ALTER TABLE boekjaar ENABLE ROW LEVEL SECURITY;
ALTER TABLE boekjaar FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON boekjaar
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE boeking ENABLE ROW LEVEL SECURITY;
ALTER TABLE boeking FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON boeking
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE boekingsregel ENABLE ROW LEVEL SECURITY;
ALTER TABLE boekingsregel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON boekingsregel
  USING      (EXISTS (
    SELECT 1 FROM boeking b
     WHERE b.id = boekingsregel.boeking_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM boeking b
     WHERE b.id = boekingsregel.boeking_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ));