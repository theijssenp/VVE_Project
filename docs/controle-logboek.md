# Controlelogboek — onafhankelijke toets per werkblok

Doel: nagaan of de blokken die in [`WERKPLAN.md`](../WERKPLAN.md) op `klaar` staan, werkelijk
leveren wat ze beloven. Dit is een **toets achteraf**, geen tweede bouwronde: er is hier
niets aan de code veranderd. Wat hieronder staat, is gezien; wat er niet staat, is niet
gecontroleerd.

**Gecontroleerde staat:** commit `c8458dc` (A06), 11-09-2026.
**Stand volgens het werkplan:** 29 van 71 blokken `klaar`.

## Hoe er getoetst is

Per blok vier vragen:

1. **Bestaat het?** — code, migratie, aansluiting op `app.module.ts`, en of het over HTTP
   bereikbaar is.
2. **Is het getest?** — bestaat er een test, en dekt die de acceptatiecriteria en de
   genummerde spec-tests die het werkplan bij het blok noemt.
3. **Klopt het met de spec?** — steekproef op de genoemde AC-nummers.
4. **Wat ontbreekt?** — afwijkingen en beweringen die de code niet waarmaakt.

Oordeel: **akkoord** · **akkoord met kanttekening** · **gat**.

Één ding is bewust _niet_ getoetst: of de berekeningen inhoudelijk juist zijn volgens boek 5
BW en de modelreglementen. Dat is juridisch werk, geen codewerk.

## Bevindingenregister

| Nr   | Blok | Ernst    | Bevinding                                                                                                                                                                                                     |
| ---- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-01 | F07  | **hoog** | MFA is nergens over HTTP bereikbaar: geen endpoint voor passkeys, TOTP of herstelcodes. Het blok staat op `klaar`.                                                                                            |
| B-02 | G02  | **hoog** | `boekjaar afsluiten` is daardoor voor iedereen onbereikbaar: het recht zit in de geldstroomlijst en de RolGuard eist een tweede factor die niemand kan activeren.                                             |
| B-03 | F11  | middel   | Het MFA-scherm van de client POST naar `/api/auth/mfa`, een route die niet bestaat. Dode flow.                                                                                                                |
| B-04 | V01  | middel   | Geen enkele servertest. Spec-test #29 (wachtwoord opnieuw zetten trekt álle sessies in) is ongetest, terwijl de code het wél doet.                                                                            |
| B-05 | F06  | middel   | Spec-test #35 is half: de familie wordt ingetrokken, de waarschuwingsmail bestaat niet. Het werkplan claimt test 35.                                                                                          |
| B-06 | F04  | middel   | Zeven tabellen zonder RLS. Voor één (`persoon`) staat een onderbouwing; voor `rol_toewijzing` en `apparaat_sessie` belooft migratie 0003 policies in F06/F08 — die blokken zijn `klaar`, de policies er niet. |
| B-07 | F04  | laag     | De RLS-test oefent alleen de tabel `vve`. Spec-test #33 noemt `nota`. De test is niet meegegroeid met de 27 andere tabellen.                                                                                  |
| B-08 | G06  | laag     | Spec-test #10 vraagt 50 gelijktijdige generaties; de test doet er 15.                                                                                                                                         |
| B-09 | plan | middel   | Spec-tests #26, #27 en #28 staan in geen enkel werkblok. Ze worden dus nooit gebouwd. #27 wordt in §8.1 juist als kernverdediging genoemd.                                                                    |

Wat hier **niet** in staat is even belangrijk: de 24 migraties, de RLS-uitrol over 28
tabellen, de hashketen, de tokenrotatie en de financiële kern zijn stuk voor stuk
gecontroleerd en houden stand. De tests toetsen gedrag, geen gelukkige paden.

## Fase 0 — Fundament

### F01 — Monorepo, strict TypeScript, ESLint, Prettier, Vitest, CI · **akkoord**

- `tsconfig.base.json`: `strict` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`. Strenger dan gevraagd.
- `eslint.config.mjs:127` spreidt `tseslint.configs.strictTypeChecked` werkelijk in.
- `.github/workflows/ci.yml`: `lint` → `format:check` → `test` → `build` → `build:app`,
  plus `npm audit --audit-level=high`. Node 22, `npm ci`.

### F02 — Docker Compose, `.env`, vastgezette images · **akkoord**

- `infra/docker-compose.yml`: postgres, api en caddy; base images op **digest**, niet op
  tag. Geen `env_file` op caddy (die heeft de databasesecrets niet nodig).
- `POSTGRES_PASSWORD` heeft een `:?`-guard: zonder waarde faalt de opdracht hoorbaar in
  plaats van stil met een zwak wachtwoord te starten.
- `.env` staat in `.gitignore` (geverifieerd met `git check-ignore`); `.env.voorbeeld` is
  de sjabloon in de repo.
- `infra/api.Dockerfile` draait als non-root en kopieert de `.sql`-migraties expliciet mee,
  omdat `tsc` dat niet doet.

### F03 — Drizzle, migratierunner, Testcontainers · **akkoord**

- De runner boekt per migratie een **sha256** en weigert te draaien zodra een toegepaste
  migratie is bewerkt — dat maakt "alleen voorwaarts" afdwingbaar in plaats van een
  afspraak. `pg_advisory_lock` serialiseert gelijktijdige runs.
- `migraties.e2e-spec.ts` toetst precies dat: volgorde, checksumweigering, vastlegging,
  en dat een tweede run niets toevoegt.
- `schema.e2e-spec.ts` toetst de CHECK-constraints en de case-insensitieve unieke e-mail.

### F04 — Row-Level Security · **akkoord met kanttekening** (B-06, B-07)

- 28 van de 35 tabellen hebben `ENABLE` **én** `FORCE ROW LEVEL SECURITY` met een
  `tenant_isolatie`-policy. Die discipline is consequent doorgetrokken: elke nieuwe
  tenant-tabel uit V02 t/m A06 kreeg zijn policy mee. Dat is de moeite waard om te noemen,
  want dit is precies het soort ding dat na blok drie pleegt te verwateren.
- `inTenantTransactie` zet `app.vve_id` met `SET LOCAL` binnen dezelfde transactie als de
  query — transactielokaal, dus pooling in transaction-modus lekt niet door naar de
  volgende gebruiker. In 17 bestanden in gebruik.
- `rls.e2e-spec.ts` bewijst fail-closed gedrag, isolatie, BYPASSRLS voor `vve_platform`,
  en dat de instelling ná de transactie weg is.

Zonder RLS: `apparaat_sessie`, `audit_log`, `instelling`, `mail_wachtrij`, `passkey`,
`persoon`, `rol_toewijzing`. Voor `persoon` staat de onderbouwing in migratie 0003
(tenant-overstijgend; RLS zou inloggen onmogelijk maken). Voor de andere zes niet — en
voor twee ervan belooft diezelfde migratie letterlijk policies in F06/F08.

### F05 — Domeinpakket financieel · **akkoord**

- `bedrag.ts`, `verdeler.ts`, `delen.ts`, `klok.ts`, elk met een eigen spec ernaast.
- De ESLint-regel `vve/cent-rekenkunde` is een **eigen** regel: rekenkundige operatoren op
  namen eindigend op `_cent`/`_centen`/`Cent` zijn een `error`, met alleen de geldlaag zelf
  uitgezonderd. Dat maakt §7.3 afdwingbaar in plaats van een afspraak.

### F06 — Auth: argon2id, tokens, rotatie · **akkoord met kanttekening** (B-05)

`token.e2e-spec.ts` en `inlog.e2e-spec.ts` toetsen het echte werk: het ruwe refresh-token
staat alleen als sha256 in de database; rotatie weigert het oude token; **hergebruik trekt
de hele familie in**; de service start niet zonder `JWT_SECRET` en weigert een te kort
geheim; vijf mislukte pogingen blokkeren; een onbekend adres kost vergelijkbare tijd als
een bestaand (timing-gelijkheid, met een echte test).

Kanttekening: spec-test #35 vraagt intrekking **en een waarschuwingsmail**. In de hele
auth-laag zit geen mailkoppeling. De controller vangt hergebruik in een kale `catch` en
maakt er 401 "Sessie verlopen" van — functioneel juist, maar de gebruiker hoort in dit
geval nu juist iets te merken.

### F07 — MFA · **gat** (B-01)

De servicelaag is er en is getest: TOTP-activatie met versleuteld secret, tien eenmalige
herstelcodes, de MFA-gate op de geldstroomrechten, en kolomversleuteling die
geauthenticeerd is (gewijzigde byte wordt geweigerd) en aan de rij gebonden.

Maar: **er is geen enkel HTTP-endpoint.** De volledige routelijst van `modules/auth` is
`inloggen`, `verversen`, `uitloggen`, `apparaten`, `mij`, `actieve-vve`. Geen registratie
of verificatie van een passkey, geen TOTP-activatie, geen herstelcodes. `passkey.ts` (276
regels) wordt door geen enkele controller aangeroepen. De inlogroute geeft
`mfaVereist: false` als vaste waarde terug ([auth.controller.ts:138](../apps/api/src/modules/auth/auth.controller.ts:138)).

Niemand kan dus een tweede factor activeren. Het blok staat op `klaar`.

### F08 — Guards en rechtdeclaraties · **akkoord**

`guards.e2e-spec.ts` dekt test #32 in drie vormen (echte routes geïnventariseerd, een route
zonder declaratie laat de applicatie niet starten, handler wint van klasse), AuthGuard,
TenantGuard, RolGuard inclusief de MFA-poort, en test #30 (`.strict()` weigert een onbekend
veld). Dit is het sterkste geteste blok van het fundament.

### F09 — Auditlog met hashketen · **akkoord**

`audit.e2e-spec.ts` dekt test #38 in beide vormen — een gewijzigde régel én een verwijderde
regel breken de keten aantoonbaar — plus deterministische canonieke JSON, het
`vorige_hash`-hiaat, alleen-INSERT-rechten voor `vve_app`, en dat gelijktijdige registraties
de keten niet vertakken.

### F10 — pg-boss, mailwachtrij, verzendworker · **akkoord**

Backoff met een toekomstig afleververster, maximaal aantal pogingen, en het bewijs dat
gevoelige berichten hun tekst niet in de wachtrij achterlaten.

### F11 — Ionic-schil · **akkoord met kanttekening** (B-03)

Routing, tokenopslag, interceptor, foutafhandeling, startscherm per rol en sessieherstel
bij herladen zijn er en getest (22 tests in `kern.spec.ts`). Het access-token blijft in het
geheugen; het refresh-token staat op web alleen in de httpOnly-cookie — getest dat
`localStorage` en `sessionStorage` niet worden aangeraakt.

Kanttekening: `auth.service.ts:109` post naar `/auth/mfa`, en die route bestaat niet. Zolang
de server `mfaVereist: false` teruggeeft wordt het scherm nooit getoond, dus het valt niet
op — maar het is dode code die een bestaande flow suggereert.

### F12 — Beveiligingswachters · **akkoord**

De wachtwoordgenerator wordt statistisch getoetst: chi-kwadraat over een miljoen
trekkingen, alfabetdekking over alle 59 symbolen, geen modulo-bias, geen duplicaten over
100.000 wachtwoorden. Dat is een serieuze test, geen vinkje. Daarnaast de eigen ESLint-regel
`vve/beveiligingswachters`.

## Fase 1 — VvE en eenheden

### V01 — VvE-beheer door de applicatiebeheerder · **gat** (B-04)

De functionaliteit is er en werkt (zelf in de browser nagelopen bij de bouw van het
startscherm per rol): aanmaken, wijzigen, archiveren, beheerder koppelen, wachtwoord
uitreiken, alles achter `#eisApplicatiebeheerder`.

Maar er is **geen servertest voor dit blok**. `actieve-vve.e2e-spec.ts` klinkt alsof het erbij
hoort maar gaat over V02 (de `vve_id`-claim). Daarmee is spec-test #29 — "wachtwoord
opnieuw versturen invalideert het oude wachtwoord én alle `apparaat_sessie`-rijen" —
ongetoetst, terwijl de code in `vve.service.ts` het wel degelijk doet. Juist die twee
regels verdienen een test: als ze ooit sneuvelen, merkt niemand het.

Dit blok heb ik zelf mee helpen committen zonder het te zien.

### V02 — Wooneenheden · **akkoord**

`eenheden.e2e-spec.ts` dekt AC2.1 en AC2.3 letterlijk zoals de spec hem formuleert:
_waarschuwt, blokkeert niet_, en toont het verschil. Plus dubbele codes binnen één VvE
geweigerd maar tussen VvE's toegestaan, RLS-isolatie in twee richtingen, en teller > noemer
geweigerd.

### V04 — Uitnodigingen · **akkoord**

Opak token, eenmalig bruikbaar, verlopen geweigerd, opnieuw versturen maakt het oude token
ongeldig, bestaande persoon direct koppelen zonder token, en tenant-scope op de eenheid.

## Fase 2 — Geldstroom

### G01 — Grootboekschema · **akkoord**

Precies de 37 rekeningen uit §5.7, idempotent kopiëren, dubbel nummer geweigerd.

### G02 — Boekjaar en boekingsservice · **akkoord met kanttekening** (B-02)

Tests #20 en #21 zijn beide echt gedekt, en het onderscheid is goed gezien: #20 toetst de
service (`OnbalansFout` vóór het schrijven), #21 toetst dat de **deferred trigger** de
directe-insert-omweg afvangt. Precies zoals de spec het bedoelt.

Kanttekening die buiten dit blok ligt maar hier landt: `POST /financieel/boekjaren/:id/afsluiten`
declareert `boekjaar.afsluiten`, en dat recht staat in `GELDSTROOM_RECHTEN`. De RolGuard
eist daarvoor een tweede factor ([guards.ts:194](../apps/api/src/gemeenschappelijk/auth/guards.ts:194)).
Omdat MFA niet te activeren is (B-01), is dit endpoint voor élk account onbereikbaar. De
test mist dat omdat hij de service rechtstreeks aanroept en de guard overslaat.

### G03 — Verdeelsleutels · **akkoord**

Alle vijf de typen getest, uitsluiting via gewicht 0, restcenten via de grootste-restmethode
met exacte som, historisering (versie+1, oude op inactief), tenant-isolatie, en twee
weigeringen aan de randen (handmatig zonder regels, alles uitgesloten).

### G04 — Begroting · **akkoord**

AC5.1-statusflow inclusief het pad dat _niet_ mag (gesloten niet bereikbaar vanuit concept)
en AC5.7-vergelijking met vorig jaar.

### G05 — Bijdrageschema · **akkoord**

Tests #5, #6 en #7 alle drie aanwezig en herkenbaar benoemd. #7 is de belangrijkste en is
er: een gewijzigde verdeelsleutel verandert reeds vastgelegde bedragen niet.

### G06 — Nota-generatie · **akkoord met kanttekening** (B-08)

Nummerreeks, betalingskenmerk, idempotentie per periode en restcentenverdeling zijn gedekt.
De concurrency-test bestaat, maar draait 15 gelijktijdige generaties waar spec-test #10 er
50 vraagt. De testtitel is eerlijk over het aantal; het werkplan claimt test 10 zonder
voorbehoud. Juist bij `FOR UPDATE`-races is het verschil tussen 15 en 50 niet academisch.

### G07 — Nota-PDF en verzending · **akkoord**

AC13.4 gedekt inclusief de postlijst voor eenheden zonder e-mail, en de bewaking tegen
dubbel verzenden.

### G08 — Betalingen · **akkoord**

Tests #8 en #9 expliciet, plus overkoppeling geweigerd (meer koppelen dan openstaat).

### G09 — Debiteurenoverzicht · **akkoord**

AC6.4 met som-gelijkheid over de buckets en AC6.8 chronologisch dossier.

### G11 — Aanmaningstraject · **akkoord**

AC6.5 volledig traject en AC6.6 correct geïmplementeerd op het punt waar het misgaat:
kosten en rente als **aparte** nota met eigen nummer uit de reeks, de oorspronkelijke nota
onveranderd. De WIK-staffel (15%, minimum € 40) is apart getest.

## Fase 3 — Bank

### B01 — IBAN-versleuteling · **akkoord**

AES-256-GCM met willekeurige nonce, deterministische HMAC-zoeksleutel over de
genormaliseerde vorm, masker volgens §6.2, mod-97-toets, en: start niet zonder
omgevingssleutels. Het zoeken zonder ontsleutelen is als geheel getest.

## Fase 6 — Vergaderingen en beheer

### A05 — Leveranciers en verplichtingen · **akkoord**

AC12.4 opzegsignalering en AC12.5 met T-60 en T-14-herinneringen live.

### A06 — Mededelingen en mailsjablonen · **akkoord**

AC13.1 doelgroepbeperking (alleen die groep krijgt mail) en AC13.3 sjabloonval terug naar
standaard.

## Losse waarneming buiten de blokken

`apps/api/src/financieel/eigenaarschap-service.ts` staat ongetrackt in de working tree,
terwijl V03 (eigenaarschap) op `todo` staat. Werk in uitvoering uit een andere sessie,
vermoedelijk — het valt buiten deze controle.
