-- 0012 — Uitnodigingen (spec §6.3 `uitnodiging`, §3.3, blok V04).
--
-- Per e-mailadres dat een beheerder aan een wooneenheid toevoegt, ontstaat
-- hier één rij met een opak token: de registratielink die de persoon zijn
-- wachtwoord laat kiezen (de §3.3-aanbevolen variant; een gemaild wachtwoord
-- blijft onbeperkt in de mailbox staan). Bestaat het adres al als persoon,
-- dan is er geen token nodig — die persoon wordt direct gekoppeld en krijgt
-- alleen de melding "u bent toegevoegd aan VvE X" (§3.3 stap 2).
--
-- Token: 32 bytes CSPRNG, alleen de sha256-hex (char(64)) gaat de database in —
-- precies het patroon van `apparaat_sessie.refresh_token_hash` (§8.2).
-- De mail met de link is `gevoelig`: de tekst wordt na verzending gewist
-- (migratie 0009, F10).
--
-- RLS: tenant-tabel (`vve_id`), zelfde patroon als 0003/0010.

CREATE TABLE uitnodiging (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id),
  wooneenheid_id   bigint      REFERENCES wooneenheid(id),
  email            citext      NOT NULL,
  rol              rol_type    NOT NULL,
  token_hash       char(64)    NOT NULL UNIQUE,
  verloopt_op      timestamptz NOT NULL,
  gebruikt_op      timestamptz,
  verzonden_op     timestamptz,
  aantal_verzonden smallint    NOT NULL DEFAULT 0,
  aangemaakt_door  bigint      NOT NULL REFERENCES persoon(id),
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_uitnodiging_vve ON uitnodiging (vve_id);
CREATE INDEX ix_uitnodiging_eenheid ON uitnodiging (wooneenheid_id);

ALTER TABLE uitnodiging ENABLE ROW LEVEL SECURITY;
ALTER TABLE uitnodiging FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON uitnodiging
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);