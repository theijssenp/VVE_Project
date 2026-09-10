-- 0009 — Gevoelige mailinhoud wissen na verzending (spec §8.3, §7.6).
--
-- De wachtrij bewaart de opgemaakte berichttekst, en §8.3 geeft die twee jaar
-- bewaartermijn. Voor gewone post is dat nuttig: bij een aanmaning wil je later
-- kunnen aantonen wát er is verstuurd. Maar de knop "opnieuw wachtwoord
-- versturen" (§3.3) zet een gegenereerd wachtwoord in diezelfde tekst, en dan
-- staat dat wachtwoord twee jaar leesbaar in de database en in elke back-up —
-- terwijl het na aflevering nergens meer voor nodig is.
--
-- Deze vlag markeert zulke berichten; de verzendworker wist de tekst zodra de
-- aflevering is geslaagd. De regel zelf blijft staan, zodat het bewijs dát er
-- iets is verstuurd bewaard blijft.
ALTER TABLE mail_wachtrij
  ADD COLUMN gevoelig boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mail_wachtrij.gevoelig IS
  'Bericht bevat een geheim (wachtwoord, instellink); tekst wordt gewist na geslaagde verzending.';
