-- 0028 — Matchingvoorstellen en opslaanbare boekingsregels (blok B05, AC7.4–7.5).
--
-- Twee dingen:
--   bank_voorstel      wat de motor van een mutatie denkt, met de reden erbij;
--   bank_boekingsregel de vuistregels die de gebruiker zelf opslaat
--                      ("bevat 'Vitens' → grootboek 4310").
--
-- Een voorstel is nadrukkelijk géén boeking. De motor mag zeker zijn, maar het
-- zeker weten van een machine is bij geld niet genoeg; pas de bevestiging van
-- de gebruiker, of een match die per definitie exact is (betalingskenmerk),
-- leidt tot een koppeling.

CREATE TYPE bank_match_soort AS ENUM (
  'betalingskenmerk',
  'end_to_end',
  'iban_bedrag',
  'iban_fifo',
  'leverancier',
  'boekingsregel',
  'intern'
);

CREATE TABLE bank_voorstel (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  bankmutatie_id   bigint      NOT NULL REFERENCES bankmutatie(id) ON DELETE CASCADE,
  soort            bank_match_soort NOT NULL,
  -- Waar dit voorstel naartoe wijst; precies één hiervan is gevuld.
  nota_id          bigint      REFERENCES nota(id) ON DELETE CASCADE,
  grootboekrekening_id bigint  REFERENCES grootboekrekening(id),
  wooneenheid_id   bigint      REFERENCES wooneenheid(id),
  bedrag_cent      bigint      NOT NULL,
  -- Zekerheid 100 = exact, lager = voorstel. De motor boekt alleen op 100.
  zekerheid        smallint    NOT NULL,
  toelichting      text        NOT NULL,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_bank_voorstel_mutatie ON bank_voorstel (bankmutatie_id);

CREATE TABLE bank_boekingsregel (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id) ON DELETE CASCADE,
  -- Tekst die in de omschrijving of de tegenpartijnaam moet voorkomen.
  bevat            text        NOT NULL,
  grootboekrekening_id bigint  NOT NULL REFERENCES grootboekrekening(id),
  omschrijving     text,
  -- Hoe vaak deze regel raak was; puur informatief, maar het maakt zichtbaar
  -- welke regels dood gewicht zijn geworden.
  aantal_toepassingen integer  NOT NULL DEFAULT 0,
  actief           boolean     NOT NULL DEFAULT true,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vve_id, bevat)
);

ALTER TABLE bank_voorstel ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_voorstel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bank_voorstel
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE bank_boekingsregel ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_boekingsregel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON bank_boekingsregel
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_voorstel, bank_boekingsregel TO vve_app;
GRANT SELECT ON bank_voorstel, bank_boekingsregel TO vve_platform;
