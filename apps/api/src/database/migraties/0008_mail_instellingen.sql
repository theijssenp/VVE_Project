-- 0008 — Mailwachtrij (spec §6.8/§7.7, blok F10).
--
-- Alle uitgaande mail loopt via de wachtrij: een falende SMTP mag nooit een
-- gebruikersactie laten mislukken (§7.1, §7.7). Statusflow: wachtend → bezig →
-- verzonden | mislukt (met pogingenteller en backoff — de worker beheert die,
-- max 5 pogingen, §7.7 mail:verwerk).
--
-- De wachtrij-tabel is géén pg-boss-tafel: pg-boss beheert zijn eigen schema;
-- hier staat de mail zelf (inhoud, ontvanger, status, bewijslast §13.5).

-- ---------------------------------------------------------------------------
-- mail_wachtrij — uitgaande mail met status en pogingenteller (§6.8)
-- ---------------------------------------------------------------------------
CREATE TABLE mail_wachtrij (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint,                    -- NULL bij systeembericht (auditverificatie, alarm)
  ontvanger_email   citext     NOT NULL,
  antwoord_adres    text,
  onderwerp         text       NOT NULL,
  tekst             text       NOT NULL,       -- opgemaakt bericht (plaintext of HTML, zie formaat)
  is_html           boolean    NOT NULL DEFAULT false,
  bijlage_pad       text,                      -- bijlage buiten de webroot (§3.2), bijv. nota-PDF
  categorie         text       NOT NULL DEFAULT 'app',  -- app | financieel | beveiliging
  status            mail_status NOT NULL DEFAULT 'wachtend',
  aantal_pogingen   smallint   NOT NULL DEFAULT 0,
  laatste_poging_op timestamptz,
  foutmelding       text,
  aflever_vóór      timestamptz,               -- gewenste verzendtijd (notitie: §13.4-series)
  aangemaakt_op     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mail_status ON mail_wachtrij (status, aflever_vóór);

-- ---------------------------------------------------------------------------
-- instelling — systeeminstellingen (§6.8, de instellingen uit §3.3/M1/M8)
-- ---------------------------------------------------------------------------
CREATE TABLE instelling (
  sleutel       text        PRIMARY KEY,
  waarde        jsonb       NOT NULL,
  gewijzigd_op  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instelling (sleutel, waarde) VALUES
  ('auth.uitnodiging_methode', '"link"'::jsonb),
  ('sepa.altijd_rcur', 'true'::jsonb),
  ('audit.hoofdhash_versturen_aan', '""'::jsonb);