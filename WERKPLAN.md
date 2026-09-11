# Werkplan VvE-applicatie — werkblokken en voortgang

Hoort bij [VVE_APPLICATIE_SPEC.md](VVE_APPLICATIE_SPEC.md). De spec zegt *wat* er gebouwd wordt; dit document zegt *in welke stukken* en *hoe ver we zijn*.

---

## 1. Werkwijze

**Een werkblok is af als:**

1. de code werkt en de bijbehorende tests groen zijn;
2. `git commit` gedaan is met een bericht dat het blok-ID noemt (`F04: RLS-rollen en tenanttransactie`);
3. de statuskolom in dit document op `klaar` staat;
4. eventuele ontwerpkeuzes in `docs/besluiten.md` staan.

**Blokken zijn zo geknipt dat elk blok op zichzelf staat.** Een nieuwe sessie heeft genoeg aan: dit werkplan, de genoemde spec-paragrafen en de repository. Er is geen kennis nodig uit een vorig gesprek. Dat is de eigenlijke bescherming tegen het opraken van tokens — niet het vooraf voorspellen van het budget, maar zorgen dat afbreken nooit werk kost.

**Omvang:** `S` klein, `M` normaal, `L` groot — bij `L` eerst kijken of het in tweeën kan.

### Tokenbewaking

Aan het begin van elk blok wordt het resterende sessiebudget genoemd en gewogen tegen de omvang van het blok. Ligt het budget onder wat het blok vraagt, dan begint het blok **niet**: we sluiten netjes af (committen, status bijwerken) en gaan verder in een nieuwe sessie.

Wat wél kan worden gezien: het budget van de lopende sessie. Wat **niet**: het account- of weeklimiet. Dat is ook niet nodig zolang de blokken klein en zelfstandig zijn — dan is opraken hooguit een onderbreking, nooit verlies.

Vuistregel per omvang: `S` ≈ één ronde, `M` ≈ enkele rondes, `L` ≈ een volle sessie. Start een `L` niet op een restbudget.

### Herstartprotocol

Een nieuwe sessie begint met: "Lees WERKPLAN.md, pak het eerste blok met status `todo` waarvan alle afhankelijkheden `klaar` zijn, lees de genoemde spec-paragrafen, en bouw dat blok."

---

## 2. Fase 0 — Fundament

Zonder deze blokken kan er niets anders gebouwd worden. F03 t/m F09 zijn de dragende constructie van de beveiliging; hier niet in snijden.

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| F01 | Monorepo (npm workspaces), TypeScript strict, ESLint `strict-type-checked`, Prettier, Vitest, CI-pipeline | S | — | §7.2 | **klaar** |
| F02 | Docker Compose (Postgres, API, Caddy), `.env`-structuur, secrets buiten de repo, vastgezette base images | S | F01 | §7.9, §8.2 | **klaar** |
| F03 | Drizzle-opzet, migratierunner, Testcontainers-harnas, eerste migratie (`vve`, `persoon`) | M | F02 | §6.1, §6.3 | **klaar** |
| F04 | RLS: rollen `vve_migratie`/`vve_app`/`vve_platform`, policies, `SET LOCAL`-transactiehelper | M | F03 | §6.9 · test 33 | **klaar** |
| F05 | Domeinpakket financieel: `Bedrag`, `Verdeler` (grootste-restmethode), `Klok`; ESLint-regels tegen ruwe centenrekenkunde en `new Date()` | M | F01 | §5.2, §7.3 · tests 1–4 | **klaar** |
| F06 | Auth: argon2id, inloggen, JWT-access, refresh met rotatie en hergebruikdetectie, `apparaat_sessie`, apparatenlijst | L | F04 | §7.6 · test 35 | **klaar** |
| F07 | MFA: passkeys (SimpleWebAuthn) als primaire methode, TOTP en herstelcodes als terugval, koppeling aan geldstroomrechten | M | F06 | §7.6, §8.5 | **klaar** |
| F08 | `AuthGuard`, `TenantGuard`, `RolGuard`, Zod-validatiepipe met `.strict()`, opstarttest op rechtdeclaraties | M | F06 | §7.5 · tests 30, 32 | **klaar** |
| F09 | Auditlog met hashketen, interceptor, dagelijkse ketenverificatie, alleen-INSERT-recht | M | F08 | §6.8 · test 38 | **klaar** |
| F10 | pg-boss, mailwachtrij, mailsjablonen, verzendworker met backoff | M | F03 | §7.7, M13 | **klaar** |
| F11 | Ionic-schil: routing, tokenopslag (cookie op web, Secure Storage native), HTTP-interceptor, foutafhandeling, inlog- en MFA-schermen | L | F07 | §7.8 | klaar |
| F12 | Beveiligingswachters tegen zwakke geheimen: ESLint-regels (`Math.random` verboden buiten tests, `===` op token-/hashvelden, niet-variabele IV bij `createCipheriv`, geen secret in log- of auditpaden) plus een statistische test op de wachtwoordgenerator (lengte, alfabetdekking, uniformiteit over 1 mln trekkingen, geen duplicaten, geen modulo-bias) | M | F07 | §7.6, §8.5 | **klaar** |

## 3. Fase 1 — VvE, eenheden, gebruikers, documenten

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| V01 | VvE aanmaken en beheren door applicatiebeheerder; beheerderaccount; instellink én "opnieuw wachtwoord versturen" | M | F08, F10 | M1, §3.3 · AC1.1–1.5 | **klaar** |
| V02 | Wooneenheden: CRUD, typen, m², breukdelen, stemmen, controle op de som van de breukdelen | M | V01 | M2 · AC2.1–2.3 | **klaar** |
| V03 | Eigenaarschap met `daterange`, exclusion constraint, meerdere eigenaren, eigenaarswissel met verrekenoverzicht voor de notaris | L | V02 | M2 · AC2.4–2.5, test 34 | todo |
| V04 | Uitnodigingen: token, verlopen, opnieuw versturen, registratie- en activatieflow, bestaande persoon koppelen | M | V01 | §3.3 · AC2.2 | **klaar** |
| V05 | Documenten: upload met MIME-detectie, opslag buiten de webroot, zichtbaarheid, download-endpoint, versiebeheer, zoeken | L | F08 | M3 · AC3.1–3.7 | todo |
| V06 | CSV/XLSX-import van eenheden en eigenaren met validatie vooraf en dry-run-rapport | M | V03 | M2 · AC2.7 | todo |
| V07 | Eigenaarsportaal v1: eigen eenheid, documenten, mededelingen, eigen gegevens | M | F11, V05 | M14 · AC14.1–14.3 | todo |

## 4. Fase 2 — Begroting, bijdragen en nota's (overboeking)

Alles in deze fase werkt zónder incasso. Het betalingskenmerk op de nota is hier de spil.

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| G01 | Standaard grootboekschema als seed, rekeningbeheer per VvE | S | V01 | §5.7 · AC9.1 | **klaar** |
| G02 | Boekjaar, boekingsservice, deferred constraint trigger, append-only rechten | M | G01 | §6.7, §7.4 · tests 20–21 | **klaar** |
| G03 | Verdeelsleutels: vijf typen, uitsluitingen, voorbeeldberekening, versiebeheer | M | V02, F05 | M4 · AC4.1–4.5 | **klaar** |
| G04 | Begroting: regels, statusflow, vergelijking met vorig jaar, PDF voor de ALV | M | G03 | M5 · AC5.1, AC5.7 | **klaar** |
| G05 | Bijdrageschema: `uit_begroting`, `vast_bedrag` en `vierkante_meters`, splitsing exploitatie/reservefonds, oud-versus-nieuw-scherm | L | G04 | M5 · AC5.2–5.5, tests 5–7 | **klaar** |
| G06 | Nummerreeksen met `FOR UPDATE`, nota-generatie per periode, betalingskenmerk | M | G05, G02 | M6 · AC6.1–6.2, test 10 | **klaar** |
| G07 | Nota-PDF, verzending via de mailwachtrij, postlijst voor eenheden zonder e-mail | M | G06, F10 | M13 · AC13.4 | todo |
| G08 | Betalingen handmatig registreren, koppelen, deelbetaling en vooruitbetaling met creditsaldo | M | G06 | M6 · AC6.3, tests 8–9 | todo |
| G09 | Debiteurenoverzicht met ouderdomsanalyse en debiteurendossier als PDF | M | G08 | M6 · AC6.4, AC6.8 | todo |
| G10 | Openingsbalans en overnamewizard voor een bestaande VvE | L | G08 | §13.2 · AC5.6 | todo |
| G11 | Aanmaningstraject in drie stappen, WIK-brief, rente en incassokosten als aparte nota | M | G09 | §5.5 · AC6.5–6.6 | todo |

## 5. Fase 3 — Bank, afletteren en jaarrekening

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| B01 | IBAN-versleuteling: AES-256-GCM, HMAC-zoeksleutel, masker, sleutelversie, rotatietaak | M | F03 | §6.2 | **klaar** |
| B02 | CAMT.053-parser met fixtures, duplicaatdetectie, saldocontinuïteit | L | B01 | §10 · tests 11–12 | todo |
| B03 | MT940-parser voor ING en Rabobank, genormaliseerd naar hetzelfde model | M | B02 | §10 · test 14 | todo |
| B04 | CSV-bankprofielen met kolommapping en encodingdetectie | M | B02 | §10 · AC7.1 | todo |
| B05 | Matchingmotor (kenmerk → E2E → IBAN-HMAC → FIFO → leverancier), werkbak, opslaanbare boekingsregels | L | B02, G08 | M7 · test 13, AC7.4–7.5 | todo |
| B06 | Bankrekeningen, saldocontrole, herkenning van interne overboekingen tussen eigen rekeningen | M | B05 | M7 · AC7.3, AC7.6 | todo |
| B07 | Proefbalans, saldibalans, grootboekweergave met doorklik naar brondocument | M | G02 | M9 · AC9.8 | todo |
| B08 | Jaarrekening: balans en staat van baten en lasten, PDF en XLSX | M | B07 | M9 · AC9.4 | todo |
| B09 | Afrekening servicekosten per eenheid, pro rata bij eigenaarswissel | L | B08, V03 | M9 · AC9.5–9.6, tests 22–23 | todo |
| B10 | Boekjaar afsluiten, vergrendelen, resultaatbestemming, kascommissie-modus | M | B09 | M9 · AC9.3, AC9.7 | todo |
| B11 | **Live-gang pilot-VvE** — data-overname, controlelijst, back-uptest, restoreproef | S | B10 | §8.6 | todo |

## 6. Fase 4 — SEPA-incasso, tijdens de pilot

Pas beginnen als de pilot minstens één maand op overboeking heeft gedraaid.

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| I01 | Mandaatbeheer, kenmerkopbouw, import van bestaande mandaten met oorspronkelijke datum, `MandaatBron`-interface | M | B01 | M8 · AC8.1, AC8.8 | todo |
| I02 | Digitale machtiging in het portaal met bewijsvastlegging (tekst-hash, IP, tijdstip) | M | I01, V07 | M8 · AC8.2 | todo |
| I03 | Vier-ogen op batch en IBAN-wijziging, herauthenticatie met MFA, alarmmail aan alle bestuursleden, afkoelperiode van 24 uur | M | I01, F07 | §8.5 · test 37 | todo |
| I04 | pain.008-generator met XSD-validatie via `xmllint`, `CtrlSum`, `SeqTp`-logica | L | I03 | M8 · tests 15–17, 19 | todo |
| I05 | Vooraankondiging, batchflow met statussen, uitsluitingsrapport, incassotermijn met werkdagenkalender | M | I04 | M8 · AC8.5–8.6, AC8.9 | todo |
| I06 | Stornoverwerking uit camt.054 en pain.002, blokkade na twee stornos | M | I05 | M8 · AC8.7, test 18 | todo |
| I07 | **Gecontroleerde uitrol:** narekenen zonder indienen → testbatch van één eenheid → volledige ronde | S | I06 | §12 fase 4 | todo |

## 7. Fase 5 — MJOP en reservefonds

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| M01 | MJOP, bouwelementen, activiteitengeneratie over de looptijd, indexatie | L | G01 | M10 · AC10.1–10.3, test 24 | todo |
| M02 | Reservefondsprognose, benodigde dotatie, wettelijke minimumtoets | M | M01 | M10 · AC10.4–10.5, test 25 | todo |
| M03 | Activiteiten afmelden met werkelijk bedrag, cyclus doorschuiven, scenario's naast het vastgestelde plan | M | M02 | M10 · AC10.6–10.7 | todo |
| M04 | XLSX-import van een extern MJOP en MJOP-rapport als PDF | M | M01 | M10 · AC10.8 | todo |

## 8. Fase 6 — Vergaderingen, meldingen, communicatie

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| A01 | Vergaderingen, agenda, oproeping, bewaking van de oproeptermijn uit het modelreglement | M | V07 | M11 · AC11.1–11.2 | todo |
| A02 | Presentie, volmachten, stemgewicht, quorumtoets met tweede-vergaderingsregeling | M | A01 | M11 · AC11.3, AC11.5 | todo |
| A03 | Stemmen, uitslagberekening per vereiste meerderheid, besluitenregister met koppeling aan begroting/MJOP | M | A02 | M11 · AC11.4, AC11.6–11.7 | todo |
| A04 | Meldingen met foto's, statusflow, tijdlijn, toewijzing, SLA-signalering | M | V07 | M12 · AC12.1–12.3 | todo |
| A05 | Leveranciers, contracten met opzegsignalering, verplichtingenregister (keuringen, polissen) met herinneringen | M | G01 | M12 · AC12.4–12.6 | todo |
| A06 | Mededelingen, doelgroepen, mailsjablonen per VvE | S | F10 | M13 · AC13.1, AC13.3 | todo |

## 9. Fase 7 — Native app

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| N01 | Capacitor-build voor iOS en Android, `client`-claim afgedwongen op de server | M | F11 | §7.8 · test 36 | todo |
| N02 | WebAuthn via native plugin (passkeys binnen de app) | M | N01, F07 | §7.6 | todo |
| N03 | Push-notificaties zonder bedragen of persoonsgegevens in de tekst | M | N01 | §10 | todo |
| N04 | Privacy-scherm, biometrische ontgrendeling van het refresh token, cache wissen bij uitloggen | S | N01 | §7.8 | todo |
| N05 | App-store-publicatie: privacyverklaring, screenshots, reviewvoorbereiding | M | N04 | — | todo |

## 10. Fase 8 — Verdieping

| ID | Blok | Omvang | Na | Spec | Status |
|---|---|---|---|---|---|
| X01 | Volledige VvE-export (ZIP met CSV's, documenten, PDF's, `overzicht.html`) | M | B10 | §8.6 | todo |
| X02 | AVG-pakket: verwerkersovereenkomst, verwerkingsregister-generator, datalekprocedure, bewaartermijnentaak | M | F09 | §8.3 | todo |
| X03 | PDF-tekstextractie en volledig-tekstzoeken over documenten | M | V05 | M3 · AC3.5 | todo |
| X04 | Incasso-PSP als tweede implementatie van `MandaatBron` | M | I06 | §10 | todo |
| X05 | PSD2-koppeling als tweede implementatie van `BankmutatieBron` | L | B05 | §10 | todo |
| X06 | Verduurzaming: energielabel, maatregelen, subsidies, laadpalen | L | M03 | §12 | todo |
| X07 | Hoofdsplitsing en ondersplitsing (VvE binnen een VvE) | L | B10 | §14 | todo |
| X08 | Meertaligheid (Engels) | M | — | §9 | todo |

---

## 11. Kritieke volgorde

Deze afhankelijkheden zijn niet te omzeilen:

- **F04 vóór alles wat data leest.** RLS achteraf toevoegen betekent elk endpoint opnieuw nalopen.
- **F05 vóór elke berekening.** `Bedrag` en `Verdeler` later invoeren betekent alle financiële code herschrijven.
- **F08 vóór het eerste functionele endpoint.** De opstarttest op rechtdeclaraties moet bestaan vóórdat er routes zijn die hem kunnen falen.
- **B01 vóór B02.** Bankmutaties bevatten IBAN's; die mogen nooit onversleuteld de database in, ook niet tijdelijk.
- **B11 vóór I01.** Incasso op een administratie die nog niet klopt, is de duurste fout die deze applicatie kan maken.

**F12 mag later, maar liefst niet te laat.** De wachters zijn het meest waard vóórdat F06/F07
de wachtwoord- en tokencode schrijven: dan faalt CI op een zwak patroon in plaats van dat het
van oplettendheid bij de review afhangt. Landt F12 er toch na, dan is de eerste run meteen een
controle op wat F06/F07 hebben opgeleverd — ook nuttig, alleen achteraf. Wat het afdekt:
`Math.random()` of `Date.now()` als entropiebron, modulo-bias in het tekenalfabet, een
gegenereerd wachtwoord dat in een log of auditregel belandt, een omgevingsvlag die
authenticatie omzeilt, tokens die ongehasht worden opgeslagen, tijdsafhankelijke
tokenvergelijkingen, verlaagde argon2-parameters, en — met het oog op B01 — een vaste IV bij
AES-GCM.

## 12. Voortgang

| | Aantal |
|---|---|
| Blokken totaal | 71 |
| Klaar | 23 |
| Bezig | 0 |

Statuswaarden: `todo` · `bezig` · `klaar` · `overgeslagen`.
