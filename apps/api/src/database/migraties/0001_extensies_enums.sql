-- 0001 — Extensies en enums (spec §6.1).
--
-- Alleen voorwaarts. De enums zijn stabiel genoeg (spec §6.1 migratienotitie):
-- nu aanmaken voorkomt later churn. Waarden toevoegen kan later via ALTER TYPE ... ADD VALUE.
-- De extensies zijn IF NOT EXISTS — dus herhaald uitvoeren is veilig (idempotent).
--
-- Deze migratie legt de basis die de later migraties (0002) en het Drizzle-schema
-- (src/database/schema) aanroepen. De migratierunner bouwt de tabel migratie_historie
-- zelf aan (niet via een migratiebestand), zodat er geen kip-ei-probleem is.

-- Extensies (spec §6.1)
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitieve e-mailadressen
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy zoeken op naam/omschrijving

-- Enums (volledige lijst uit spec §6.1)
CREATE TYPE vve_status          AS ENUM ('actief','gearchiveerd');
CREATE TYPE modelreglement      AS ENUM ('MR1973','MR1983','MR1992','MR2006','MR2017','EIGEN');
CREATE TYPE rol_type            AS ENUM ('applicatiebeheerder','beheerder','voorzitter','penningmeester',
                                            'secretaris','bestuurslid','kascommissie','eigenaar','bewoner');
CREATE TYPE eenheid_type        AS ENUM ('woning','parkeerplaats','berging','bedrijfsruimte','gemeenschappelijk');
CREATE TYPE communicatie_wijze  AS ENUM ('email','post','beide');
CREATE TYPE bewoning_type       AS ENUM ('eigenaar_bewoner','huurder','gebruiker');
CREATE TYPE verdeelsleutel_type AS ENUM ('breukdeel','vierkante_meters','gelijke_delen','stemmen','handmatig');
CREATE TYPE boekjaar_status     AS ENUM ('concept','open','afgesloten');
CREATE TYPE begroting_status    AS ENUM ('concept','voorgesteld_alv','vastgesteld','gesloten');
CREATE TYPE bijdrage_methode    AS ENUM ('uit_begroting','vast_bedrag','vierkante_meters');
CREATE TYPE periodiciteit       AS ENUM ('maand','kwartaal','jaar');
CREATE TYPE bijdrage_bron       AS ENUM ('berekend','handmatig');
CREATE TYPE nota_type           AS ENUM ('periodieke_bijdrage','afrekening','eenmalige_heffing',
                                            'boete','rente','incassokosten','credit');
CREATE TYPE nota_status         AS ENUM ('concept','open','deels_betaald','betaald','gecrediteerd','oninbaar');
CREATE TYPE betaalwijze         AS ENUM ('incasso','overboeking');
CREATE TYPE bankrekening_type   AS ENUM ('exploitatie','reserve','spaar','overig');
CREATE TYPE bank_formaat        AS ENUM ('camt053','mt940','csv');
CREATE TYPE transactie_status   AS ENUM ('nieuw','voorstel','geboekt','genegeerd');
CREATE TYPE betaling_bron       AS ENUM ('bank','kas','handmatig','incasso','verrekening');
CREATE TYPE machtiging_type     AS ENUM ('CORE','B2B');
CREATE TYPE machtiging_status   AS ENUM ('actief','geblokkeerd','ingetrokken','verlopen');
CREATE TYPE sequence_type       AS ENUM ('FRST','RCUR','OOFF','FNAL');
CREATE TYPE batch_status        AS ENUM ('concept','gegenereerd','ingediend','verwerkt','geannuleerd');
CREATE TYPE incassopost_status  AS ENUM ('open','geincasseerd','gestorneerd');
CREATE TYPE grootboek_categorie AS ENUM ('activa','passiva','eigen_vermogen','lasten','baten');
CREATE TYPE boeking_bron        AS ENUM ('nota','betaling','bank','incasso','memoriaal','openingsbalans','jaarafsluiting');
CREATE TYPE afrekening_status   AS ENUM ('concept','voorgesteld_alv','vastgesteld','verwerkt');
CREATE TYPE mjop_status         AS ENUM ('concept','scenario','vastgesteld','vervallen');
CREATE TYPE activiteit_status   AS ENUM ('gepland','in_uitvoering','uitgevoerd','uitgesteld','vervallen');
CREATE TYPE verplichting_soort  AS ENUM ('liftkeuring','brandmeldinstallatie','legionella','nen3140',
                                            'opstalverzekering','aansprakelijkheid','bestuurdersaansprakelijkheid',
                                            'rechtsbijstand','energielabel','overig');
CREATE TYPE melding_prioriteit  AS ENUM ('laag','normaal','hoog','spoed');
CREATE TYPE melding_status      AS ENUM ('nieuw','in_behandeling','opdracht_verstrekt','afgerond','afgewezen');
CREATE TYPE zichtbaarheid       AS ENUM ('alle_leden','bewoners','bestuur','alleen_beheerder');
CREATE TYPE vergadering_type    AS ENUM ('alv','bijzondere_alv','bestuursvergadering');
CREATE TYPE vergadering_status  AS ENUM ('gepland','gehouden','geannuleerd');
CREATE TYPE agendapunt_soort    AS ENUM ('informatief','stemming');
CREATE TYPE vereiste_meerderheid AS ENUM ('gewoon','twee_derde','drie_kwart','unaniem');
CREATE TYPE besluit_uitslag     AS ENUM ('aangenomen','verworpen','aangehouden');
CREATE TYPE stem_keuze          AS ENUM ('voor','tegen','onthouding');
CREATE TYPE mail_status         AS ENUM ('wachtend','bezig','verzonden','mislukt');
