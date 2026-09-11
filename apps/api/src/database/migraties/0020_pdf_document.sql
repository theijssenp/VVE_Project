-- 0020 — Nota-PDF en verzending (spec §6.6 · M13 · AC13.4/AC13.5, blok G07).
--
-- G06 genereerde de nota's; dit blok levert het *bewijsstuk* (PDF, AC13.5)
-- en de serie-verzending (AC13.4) via de F10-mailwachtrij.
--
-- `pdf_document`: een gegenereerd PDF-artefact, opgeslagen als bytes. Bewust
-- geen filesysteem: de db is de bewaarplaats (AC13.5: "inclusief het
-- verzonden PDF-bestand — bewijslast bij aanmaningen"), bytea in één tabel
-- met RLS.
--
-- `nota.pdf_document_id` bestaat al (migratie 0019); hier komt de tabel waar
-- die FK naar wijst, en de verzendtelling/verzonden-op op de nota zelf is er
-- al. De verzending zelf schrijft `verzonden_op` en zet de status op 'open'
-- (al verzonden of niet, de vordering blijft open tot betaling — G08).

CREATE TABLE pdf_document (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id         bigint      NOT NULL REFERENCES vve(id),
  soort          text        NOT NULL,
  bestandsnaam   text        NOT NULL,
  inhoud         bytea       NOT NULL,
  grootte_bytes  bigint      NOT NULL CHECK (grootte_bytes >= 0),
  aangemaakt_op  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pdf_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE pdf_document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON pdf_document
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);