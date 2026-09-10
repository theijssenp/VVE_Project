-- 0007 — Auditlog met manipulatiebestendige hashketen (spec §6.8, blok F09).
--
-- Het auditlog registreert elke rechtenwijziging, elke financiële mutatie en
-- elke inzage in persoonsgegevens (§3.2). De beheerder van de applicatie is
-- ook de beheerder van de server (geen scheiding der machten), dus het log is
-- manipulatiebestendig: elke regel draagt de hash van de vorige regel
-- (vorige_hash) en zijn eigen hash over vorige_hash ‖ canonieke JSON van de
-- regel zelf. Wie een regel wijzigt of verwijdert, breekt de keten aantoonbaar
-- (test #38).
--
-- De applicatierol (vve_app) krijgt uitsluitend INSERT; UPDATE en DELETE worden
-- expliciet ontzegd. De migratierol (eigenaar) mag wel migreren.

-- ---------------------------------------------------------------------------
-- audit_log — append-only, hashketen per VvE-scope
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint,                       -- NULL bij systeem-brede acties (login, VvE-aanmaak)
  persoon_id        bigint REFERENCES persoon(id),-- wie de handeling deed (NULL bij systeem)
  gebeurtenis       text        NOT NULL,         -- bv. 'nota.genereer', 'wachtwoord.reset'
  categorie         text        NOT NULL DEFAULT 'app',  -- app | financieel | beveiliging (§7.9-logkanalen)
  onderwerp_tabel   text,                         -- betrokken tabel, voor doorklik (§9.8-auditspoor)
  onderwerp_id      bigint,                       -- betrokken rij
  details           jsonb,                        -- gestructureerde context
  ip_adres          inet,
  gebruiker_agent   text,
  gebeurtenis_op    timestamptz NOT NULL DEFAULT now(),
  vorige_hash       char(64),                     -- NULL voor de allereerste regel
  eigen_hash        char(64)    NOT NULL          -- sha256(vorige_hash ‖ canonieke JSON van deze regel)
);

-- De keten verloopt in volgorde van aanmaak; een index op (vve_id, id) voor
-- de verificatie-per-VvE en een globale op id (identity is stijgend).
CREATE INDEX ix_audit_vve_op ON audit_log (vve_id, gebeurtenis_op);
CREATE INDEX ix_audit_categorie ON audit_log (categorie);

-- ---------------------------------------------------------------------------
-- Alleen-INSERT-recht (spec §6.8): vve_app mag schrijven, nooit muteren.
-- De default-privileges uit 0004 gaven brede rechten; hier expliciet terugnemen.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM vve_app;
GRANT INSERT ON audit_log TO vve_app;

-- Ook vve_platform kan niet muteren: het platform leest (monitoring), maar
-- heeft geen schrijfbehoeften hier; het audit-pad schrijft via vve_app.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM vve_platform;