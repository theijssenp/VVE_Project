-- 0003 — Row-Level Security: de tweede slotgracht (spec §6.9, blok F04).
--
-- Drie databaserollen:
--   vve_migratie  — eigenaar van het schema, alleen voor migraties (n.v.t. RLS);
--   vve_app       — alle normale requestverwerking, onderworpen aan RLS;
--   vve_platform  — uitsluitend expliciet gemarkeerde beheerendpoints, BYPASSRLS,
--                   elke query gelogd (die logging volgt in een later blok).
--
-- Per tenant-tabel: ENABLE + FORCE ROW LEVEL SECURITY en één policy
-- tenant_isolatie met USING en WITH CHECK op app.vve_id. current_setting()
-- zonder tweede parameter werpt een fout als de instelling niet gezet is —
-- fail closed: een query buiten een tenant-context faalt hard.
--
-- De migratierunner voert dit bestand uit als de superuser van de
-- test-container (vve), die de rollen aanmaakt; de applicatie verbindt straks
-- als vve_app, migraties blijven op de eigenaarsrol.

-- ---------------------------------------------------------------------------
-- Rollen
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vve_migratie') THEN
    CREATE ROLE vve_migratie NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vve_app') THEN
    CREATE ROLE vve_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vve_platform') THEN
    -- BYPASSRLS is een attribuut op rolniveau; alleen vve_platform krijgt het.
    CREATE ROLE vve_platform NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants: de applicatierol leest en schrijft, maar beheert niets.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO vve_app, vve_migratie, vve_platform;

-- ---------------------------------------------------------------------------
-- RLS op de bestaande tenant-tabellen (F03): vve en persoon.
-- Elke latere tenant-tabel krijgt hetzelfde blok in zijn eigen migratie.
-- ---------------------------------------------------------------------------

-- vve: de tenant-tabel zelf. Hier is de kolom `id` (de VvE-sleutel) de kolom
-- waarop de policy aangrijpt; op latere tabellen (nota, eenheid, …) heet de
-- kolom `vve_id` en volgt de policy het patroon uit §6.9 letterlijk.
ALTER TABLE vve ENABLE ROW LEVEL SECURITY;
ALTER TABLE vve FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolatie ON vve
  USING      (id = current_setting('app.vve_id')::bigint)
  WITH CHECK (id = current_setting('app.vve_id')::bigint);

-- persoon: géén vve_id-kolom (§6.3: personen zijn tenant-overstijgend; koppeling
-- loopt via rol_toewijzing). Deze tabel is géén tenant-tabel en krijgt daarom
-- géén RLS-policy op app.vve_id. De API-scoping (§7.5) beschermt persoonsgegevens;
-- RLS hier zou elke login onmogelijk maken (je moet de persoon kunnen lezen
-- vóórdat er een VvE-keuze is).
--
-- rol_toewijzing, apparaat_sessie, uitnodiging en wachtwoord_reset komen in
-- latere blokken (F06/F08) met hun eigen policies.

-- ---------------------------------------------------------------------------
-- RLS-verificatie — test #33 (spec §6.9): RLS blokkeert zelfstandig.
-- De integratietests (F04) draaien dit na tegen de echte container.
-- ---------------------------------------------------------------------------