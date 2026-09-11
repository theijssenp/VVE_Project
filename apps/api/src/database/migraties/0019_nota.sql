-- 0019 — Nota's (spec §6.6, blok G06).
--
-- De nota is de vordering op een eenheid. Nummer en betalingskenmerk zijn
-- uniek per VvE (twee UNIQUE-constraints); het kenmerk is de spil van het
-- afletteren (AC7.4-stap 1). De statusflow loopt concept → open →
-- deels_betaald → betaald (gecrediteerd/oninbaar zijn uitzonderingspaden,
-- G08/G11 bewaken die).
--
-- `nota_regel` bewaart de specificatie: exploitatie/reserve per regel (AC6.2).
--
-- RLS: patroon 0003/…/0018; nota_regel volgt de moeder via EXISTS.

CREATE TABLE nota (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id),
  wooneenheid_id   bigint      NOT NULL REFERENCES wooneenheid(id),
  persoon_id       bigint      NOT NULL REFERENCES persoon(id),   -- debiteur bij uitgifte
  boekjaar_id      bigint      NOT NULL REFERENCES boekjaar(id),
  nummer           text        NOT NULL,
  type             nota_type   NOT NULL,
  periode_van      date,
  periode_tot      date,
  factuurdatum     date        NOT NULL,
  vervaldatum      date        NOT NULL,
  bedrag_cent      bigint      NOT NULL CHECK (bedrag_cent >= 0),
  openstaand_cent  bigint      NOT NULL CHECK (openstaand_cent >= 0),
  betaalwijze      betaalwijze NOT NULL DEFAULT 'overboeking',
  betalingskenmerk text        NOT NULL,
  status           nota_status NOT NULL DEFAULT 'concept',
  verzonden_op     timestamptz,
  pdf_document_id  bigint,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vve_id, nummer),
  UNIQUE (vve_id, betalingskenmerk)
);

CREATE TABLE nota_regel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nota_id              bigint  NOT NULL REFERENCES nota(id) ON DELETE CASCADE,
  omschrijving         text    NOT NULL,
  bedrag_cent          bigint  NOT NULL CHECK (bedrag_cent >= 0),
  grootboekrekening_id bigint  NOT NULL REFERENCES grootboekrekening(id),
  is_reservefonds      boolean NOT NULL DEFAULT false
);

CREATE INDEX ix_nota_eenheid_status ON nota (wooneenheid_id, status);
CREATE INDEX ix_nota_openstaand ON nota (vve_id, vervaldatum) WHERE status IN ('open', 'deels_betaald');
CREATE INDEX ix_nota_regel_nota ON nota_regel (nota_id);

ALTER TABLE nota ENABLE ROW LEVEL SECURITY;
ALTER TABLE nota FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON nota
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE nota_regel ENABLE ROW LEVEL SECURITY;
ALTER TABLE nota_regel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON nota_regel
  USING      (EXISTS (
    SELECT 1 FROM nota n
     WHERE n.id = nota_regel.nota_id
       AND n.vve_id = current_setting('app.vve_id')::bigint
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM nota n
     WHERE n.id = nota_regel.nota_id
       AND n.vve_id = current_setting('app.vve_id')::bigint
  ));