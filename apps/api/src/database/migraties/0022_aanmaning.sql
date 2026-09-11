-- 0022 — Aanmaningstraject (spec §5.5, M6 · AC6.5/AC6.6, blok G11).
--
-- Drie stappen, elk met een eigen rij in `aanmaning`: herinnering (T+7,
-- kosteloos), aanmaning (T+21, veertiendagenbrief voor consumenten) en
-- ingebrekestelling (T+45). Elke stap is een document met tekst, datum en
-- verstuurmoment; de vervolgtermijnen staan per VvE in `aanmaning_instelling`.
--
-- AC6.6: boeterente en incassokosten gaan als APARTE nota (`nota.type` =
-- 'rente' / 'incassokosten'), nooit als aanpassing van de oorspronkelijke
-- nota. De incassokosten volgen de WIK-staffel: 15% over de eerste € 2.500
-- met minimum € 40.
--
-- RLS: patroon 0003; `aanmaning` volgt de nota via EXISTS.

-- Twee nieuwe §6.1-enums; ontbraken nog in 0001 (gecheckt — G08-les).
CREATE TYPE aanmaning_stap  AS ENUM ('herinnering','aanmaning','ingebrekestelling');
CREATE TYPE rente_grondslag AS ENUM ('wettelijk','reglementair','geen');

CREATE TABLE aanmaning_instelling (
  vve_id                    bigint  PRIMARY KEY REFERENCES vve(id),
  herinnering_dagen         int     NOT NULL DEFAULT 7,
  aanmaning_dagen           int     NOT NULL DEFAULT 21,
  ingebrekestelling_dagen   int     NOT NULL DEFAULT 45,
  rente_grondslag           rente_grondslag NOT NULL DEFAULT 'wettelijk',
  rente_percentage          numeric(5, 2) NOT NULL DEFAULT 0,
  aangemaakt_op             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aanmaning (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint         NOT NULL REFERENCES vve(id),
  nota_id            bigint         NOT NULL REFERENCES nota(id),
  stap               aanmaning_stap NOT NULL,
  verstuurd_op       date           NOT NULL,
  tekst              text           NOT NULL,
  is_veertiendagen   boolean        NOT NULL DEFAULT false,
  kosten_cent        bigint         NOT NULL DEFAULT 0,
  aangemaakt_op      timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (nota_id, stap)
);

CREATE INDEX ix_aanmaning_nota ON aanmaning (nota_id, stap);

ALTER TABLE aanmaning ENABLE ROW LEVEL SECURITY;
ALTER TABLE aanmaning FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON aanmaning
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);

ALTER TABLE aanmaning_instelling ENABLE ROW LEVEL SECURITY;
ALTER TABLE aanmaning_instelling FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON aanmaning_instelling
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);