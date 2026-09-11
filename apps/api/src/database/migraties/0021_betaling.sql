-- 0021 — Betalingen (spec §6.6, blok G08).
--
-- `betaling` is het geld-in-komst-artefact: van de bank (B05), kas of
-- handmatig. `betaling_koppeling` verdeelt een betaling over nota's — elk
-- koppelbedrag mag niet nul zijn, en de som van de koppelingen mag het
-- betaalde bedrag niet overstijgen (AC6.3; een restje blijft creditsaldo op
-- de eenheid = vooruitbetaling, test #9).
--
-- De openstaand-cent van de nota is het *afgeleide* saldo (nota_bedrag −
-- som(koppelingen)); de service berekent het per koppeling en bewaakt de
-- statusflow: open → deels_betaald → betaald. Append-only op betaling zelf:
-- corrigeren gebeurt met een tegengestelde betaling ('verrekening'), nooit
-- met UPDATE/DELETE.
--
-- `betaling_bron` bestaat al (migratie 0001, §6.1-hoofdlijst).

CREATE TABLE betaling (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint        NOT NULL REFERENCES vve(id),
  datum              date          NOT NULL,
  bedrag_cent        bigint        NOT NULL CHECK (bedrag_cent >= 0),
  bron               betaling_bron NOT NULL,
  bank_transactie_id bigint,
  wooneenheid_id     bigint        REFERENCES wooneenheid(id),
  omschrijving       text,
  aangemaakt_op      timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE betaling_koppeling (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  betaling_id bigint NOT NULL REFERENCES betaling(id) ON DELETE CASCADE,
  nota_id     bigint NOT NULL REFERENCES nota(id),
  bedrag_cent bigint NOT NULL CHECK (bedrag_cent <> 0),
  UNIQUE (betaling_id, nota_id)
);

CREATE INDEX ix_betaling_eenheid ON betaling (wooneenheid_id, datum);
CREATE INDEX ix_betaling_koppeling_nota ON betaling_koppeling (nota_id);

ALTER TABLE betaling ENABLE ROW LEVEL SECURITY;
ALTER TABLE betaling FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON betaling
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE betaling_koppeling ENABLE ROW LEVEL SECURITY;
ALTER TABLE betaling_koppeling FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON betaling_koppeling
  USING      (EXISTS (
    SELECT 1 FROM betaling b
     WHERE b.id = betaling_koppeling.betaling_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM betaling b
     WHERE b.id = betaling_koppeling.betaling_id
       AND b.vve_id = current_setting('app.vve_id')::bigint
  ));