-- 0010 — Wooneenheden en eigendom (spec §6.4, blok V02).
--
-- De juridische structuur van de VvE: gebouwen (optioneel, bij meerblokcomplexen),
-- wooneenheden (het appartementsrecht: woning/parkeerplaats/berging/…) en
-- eigenaarschap als historische koppeling met `daterange`.
--
-- RLS: alle drie de tabellen zijn tenant-tabellen (dragen `vve_id`) en volgen
-- het patroon uit 0003 letterlijk: ENABLE + FORCE + één policy `tenant_isolatie`
-- op app.vve_id, USING én WITH CHECK. Grants komen via de default privileges
-- van migratie 0004 (deze migratie draait onder dezelfde rol, vve_migratie).
--
-- Bewuste keuze: `wooneenheid.gebouw_id` verwijst alleen naar gebouw(id), zoals
-- de spec-letter. Dat een gebouw bij dezelfde VvE hoort als zijn eenheden, is
-- niet met een gewone FK te bewaken (een FK omzeilt RLS); de service zet het
-- gebouw daarom alleen binnen de tenant-transactie, op een rij die binnen die
-- zelfde transactie met vve_id is geverifieerd. Zie docs/besluiten.md, V02.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- gist-operatorklassen voor bigint/integer (EXCLUDE-constraints hieronder)

-- ---------------------------------------------------------------------------
-- gebouw — een VvE kan meerdere blokken/gebouwen hebben
-- ---------------------------------------------------------------------------
CREATE TABLE gebouw (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id bigint NOT NULL REFERENCES vve(id),
  naam   text   NOT NULL,
  adres  text
);

-- ---------------------------------------------------------------------------
-- wooneenheid — het eigendomsobject; kosten en stemmen hangen hieraan (§2)
-- ---------------------------------------------------------------------------
CREATE TABLE wooneenheid (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id                bigint        NOT NULL REFERENCES vve(id),
  gebouw_id             bigint        REFERENCES gebouw(id),
  code                  text          NOT NULL,
  type                  eenheid_type  NOT NULL DEFAULT 'woning',
  straat                text,
  huisnummer            text,
  huisnummer_toevoeging text,
  postcode              text,
  plaats                text,
  bouwlaag              smallint,
  oppervlakte_m2        numeric(10,2) CHECK (oppervlakte_m2 >= 0),
  breukdeel_teller      integer       NOT NULL DEFAULT 1 CHECK (breukdeel_teller >= 0),
  breukdeel_noemer      integer       NOT NULL DEFAULT 1000 CHECK (breukdeel_noemer > 0),
  stemmen               integer       NOT NULL DEFAULT 1 CHECK (stemmen >= 0),
  kadastrale_aanduiding text,
  actief_vanaf          date,
  actief_tot            date,
  aangemaakt_op         timestamptz   NOT NULL DEFAULT now(),
  gewijzigd_op          timestamptz,
  UNIQUE (vve_id, code)
);

-- De breukdeel-codes horen logisch bij elkaar: teller <= noemer. Table-level,
-- zodat de check op de rij valt (zelfde vorm als de vve- en rol-constraints).
ALTER TABLE wooneenheid ADD CONSTRAINT wooneenheid_breukdeel_binnen_noemer
  CHECK (breukdeel_teller <= breukdeel_noemer);

-- ---------------------------------------------------------------------------
-- eigenaarschap — historisch eigendom per daterange (§6.4)
--
-- Gedeelde eigendommen (partners, 500/500) zijn toegestaan; de som per dag
-- bewaakt de domeinlaag (test #34, blok V03). Wat Postgres hier wél kan:
-- dubbele volledige eigendommen uitsluiten, en per (eenheid, persoon) overlap
-- van periodes voorkomen — niemand staat op dezelfde dag twee keer met een
-- ander aandeel op dezelfde eenheid; een eigendomswijziging is een nieuwe rij
-- met een aangepaste periode, geen UPDATE van de oude.
-- ---------------------------------------------------------------------------
CREATE TABLE eigenaarschap (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint  NOT NULL REFERENCES vve(id),
  wooneenheid_id     bigint  NOT NULL REFERENCES wooneenheid(id),
  persoon_id         bigint  NOT NULL REFERENCES persoon(id),
  aandeel_promille   integer NOT NULL DEFAULT 1000 CHECK (aandeel_promille BETWEEN 0 AND 1000),
  is_primair_contact boolean NOT NULL DEFAULT false,
  periode            daterange NOT NULL,
  akte_datum         date,
  aangemaakt_op      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_eig_eenheid ON eigenaarschap USING gist (wooneenheid_id, periode);
CREATE INDEX ix_eig_persoon ON eigenaarschap (persoon_id);

ALTER TABLE eigenaarschap ADD CONSTRAINT geen_dubbel_volledig_eigendom
  EXCLUDE USING gist (wooneenheid_id WITH =, periode WITH &&)
  WHERE (aandeel_promille = 1000);

-- Per (eenheid, persoon) mogen periodes niet overlappen: dezelfde combinatie
-- kan niet tegelijk twee verschillende aandelen hebben.
ALTER TABLE eigenaarschap ADD CONSTRAINT eigenaarschap_per_uniek_per_persoon
  EXCLUDE USING gist (wooneenheid_id WITH =, persoon_id WITH =, periode WITH &&);

-- Een lege periode ('empty' daterange) heeft geen betekenis; weigeren.
ALTER TABLE eigenaarschap ADD CONSTRAINT eigenaarschap_periode_bevat_dagen
  CHECK (NOT isempty(periode));

-- ---------------------------------------------------------------------------
-- RLS — zelfde patroon als 0003 voor elke tenant-tabel
-- ---------------------------------------------------------------------------
ALTER TABLE gebouw ENABLE ROW LEVEL SECURITY;
ALTER TABLE gebouw FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON gebouw
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE wooneenheid ENABLE ROW LEVEL SECURITY;
ALTER TABLE wooneenheid FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON wooneenheid
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE eigenaarschap ENABLE ROW LEVEL SECURITY;
ALTER TABLE eigenaarschap FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON eigenaarschap
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);