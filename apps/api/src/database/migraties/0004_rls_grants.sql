-- 0004 — Rechten voor de applicatierol (spec §6.9, herziening op 0003).
--
-- 0003 legde de rollen en de policies aan, maar gaf `vve_app` geen enkel
-- tabelrecht. Daardoor kon die rol niets, en slaagden de RLS-tests alleen omdat
-- ze zichzelf rechten uitdeelden. Zonder deze migratie is de rol die door RLS
-- beperkt hoort te worden in de praktijk onbruikbaar — en is de verleiding groot
-- om de applicatie als eigenaar of superuser te laten verbinden, waarmee RLS
-- volledig wegvalt (een superuser omzeilt ook FORCE ROW LEVEL SECURITY).

-- Rechten op de bestaande tabellen.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vve_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vve_platform;

-- Tabellen uit latere migraties krijgen dezelfde rechten automatisch. Dit geldt
-- voor objecten die worden aangemaakt door de rol die deze migratie uitvoert;
-- migraties moeten daarom altijd onder dezelfde rol draaien (spec §7.9).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vve_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO vve_platform;

-- De migratiehistorie is beheerdata, geen tenantdata: de applicatierol hoeft er
-- niet in te schrijven en leest hem hoogstens.
REVOKE INSERT, UPDATE, DELETE ON migratie_historie FROM vve_app;

-- LOGIN en wachtwoord staan bewust NIET in een migratie: dat zijn geheimen en
-- die horen niet in de repository (spec §8.2). De operator koppelt een
-- inlogaccount aan de rol, met het wachtwoord uit `.env`:
--
--   CREATE ROLE vve_api LOGIN PASSWORD '<uit .env>';
--   GRANT vve_app TO vve_api;
--
-- De applicatie verbindt met dat account. Zij mag NOOIT als eigenaar of
-- superuser verbinden: die omzeilen RLS en maken de policies betekenisloos.
