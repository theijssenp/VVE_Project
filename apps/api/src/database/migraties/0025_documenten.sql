-- 0025 — Documentenbeheer (spec §6.9 · M3 · AC3.1–3.7, blok V05).
--
-- Alle VvE-stukken centraal, versiebeheerd en met correcte zichtbaarheid.
--
-- **Opslagmodel (AC3.7):** de bytes staan op schijf, buiten de documentroot,
-- onder een willekeurige (UUID) naam; de oorspronkelijke bestandsnaam, het
-- server-side bepaalde MIME-type en de locatie staan in de database. De
-- `opslag_pad`-kolom bewaart het pad *relatief* aan de opslagroot
-- (DOCUMENTEN_MAP): de absolute locatie verhuist mee met de omgeving zonder
-- dat de database het hoeft te weten. De db bewaart géén bytes — dat is het
-- G07-patroon alleen voor bewijsstukken (verzonden nota's); hier is het
-- bestandssysteem de bewaarplaats, zoals AC3.7 de letter stelt.
--
-- Versiebeheer (AC3.3): een nieuw document begint met `eerdere_versie_id`
-- NULL en versie 1. Een nieuwe versie van hetzelfde stuk verwijst via
-- `eerdere_versie_id` naar de rij die hij vervangt en draait versie+1. De
-- vorige versie wordt op `vervallen_op` gezet: zichtbaar voor bestuur,
-- niet meer in de standaardlijst. De keten is dus een gelinkte lijst, geen
-- (hoofd, versie)-paar: de "hoofdversie" is de rij zonder opvolger, en die
-- zoek je met de tegenovergestelde FK — bewust, zodat de migratie geen
-- gedeeltelijke index op een nullable-verwezen kolom hoeft.
--
-- Zichtbaarheid (AC3.2): de enum `zichtbaarheid` bestaat al sinds 0001
-- ('alle_leden','bewoners','bestuur','alleen_beheerder'). AC3.2 schrijft
-- 'huisregels' voor huurders; die waarde bestaat in de spec als de
-- bewoners-vorm: huurders/bewoners zien uitsluitend 'bewoners'-markering.
-- De check (AC3.2-letter) bewaken we in de service, niet met een CHECK op
-- de enum-waarde.
--
-- Koppelingen (AC3.4): boekjaar, leverancier en nota bestaan als tabellen;
-- ALV en MJOP-activiteit krijgen hun tabellen in latere blokken. Die twee
-- verwijzingen komen bewust óók als kolommen — met FK's die pas kunnen
-- vullen zodra die tabellen bestaan. Om dode FK's te vermijden (A05-patroon)
-- is dat hier geen FK maar een plain kolom: de koppeling verhuist naar het
-- blok dat de ALV-tabel levert. Boekjaar/leverancier zijn wél echte FK's.
--
-- RLS: tenant-tabel volgens het 0003-patroon (ENABLE + FORCE + één policy).

CREATE TABLE document (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint        NOT NULL REFERENCES vve(id),
  categorie          text          NOT NULL,
  titel              text          NOT NULL,
  zichtbaarheid      zichtbaarheid NOT NULL DEFAULT 'bestuur',
  opslag_pad         text          NOT NULL UNIQUE,
  originele_naam     text          NOT NULL,
  mime_type          text          NOT NULL,
  grootte_bytes      bigint        NOT NULL CHECK (grootte_bytes >= 0),
  checksum_sha256    text          NOT NULL,
  boekjaar_id        bigint        REFERENCES boekjaar(id),
  leverancier_id     bigint        REFERENCES leverancier(id),
  jaar               smallint,
  tags               text[]        NOT NULL DEFAULT '{}',
  eerdere_versie_id  bigint        REFERENCES document(id),
  versie             integer       NOT NULL DEFAULT 1 CHECK (versie >= 1),
  vervallen_op       timestamptz,
  geupload_door      bigint        NOT NULL REFERENCES persoon(id),
  aangemaakt_op      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX ix_document_vve ON document (vve_id, zichtbaarheid);
CREATE INDEX ix_document_eerdere ON document (eerdere_versie_id);
CREATE INDEX ix_document_tags ON document USING gin (tags);

ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON document
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);