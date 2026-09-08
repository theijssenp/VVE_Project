# Bouwopdracht: VvE-Beheerapplicatie (NestJS + PostgreSQL + Ionic)

> **Status:** functioneel en technisch ontwerp, bedoeld als bouwprompt.
> **Versie:** 2.0 — 2026-09-08
> **Stack:** NestJS (TypeScript) API + PostgreSQL 16 + Ionic/Capacitor client (PWA eerst, native later).
> **Doel van dit document:** een AI-assistent of ontwikkelteam kan hiermee, zonder aanvullende toelichting, een productiewaardige VvE-applicatie bouwen.

---

## 0. Hoe deze opdracht te gebruiken

1. Bouw **incrementeel per fase** (§12). Lever iedere fase op als werkende, geteste, migreerbare software. Bouw niet vooruit op latere fases, maar maak wel het datamodel uit §6 in één keer aan zodat er later geen brekende migraties nodig zijn.
2. **Wijk niet af van de domeinbegrippen** in §2. De Nederlandse VvE-terminologie is juridisch geladen; vertaal die niet naar het Engels. Tabelnamen, kolomnamen, klassenamen en UI-teksten zijn Nederlands. Framework-/infrastructuurcode mag Engels zijn.
3. **Bedrijfsregels (§5) zijn hard.** Ze zijn getoetst aan boek 5 BW, de modelreglementen en de SEPA-rulebooks. Als een implementatiekeuze botst met een bedrijfsregel, wint de bedrijfsregel.
4. Als een detail ontbreekt: kies de optie die (a) juridisch veilig is, (b) een bestaande VvE zonder dataverlies laat overstappen, (c) door een vrijwillige penningmeester zonder boekhoudopleiding te bedienen is. Documenteer de keuze in `docs/besluiten.md`.
4b. Dit is een **API-first** applicatie. Er bestaat geen server-rendered HTML als tweede slotgracht: elk endpoint is direct aanroepbaar. Autorisatie staat daarom volledig op de API (§7.5) en wordt in de database nog een keer afgedwongen met Row-Level Security (§6.9).
5. Alles wat geld raakt is **integer in centen**. Geen floats. Nergens.

---

## 1. Context en doelstelling

Een Vereniging van Eigenaren (VvE) is de rechtspersoon die ontstaat bij splitsing van een gebouw in appartementsrechten. In Nederland zijn er circa 145.000 VvE's, waarvan een groot deel klein is (2–20 eenheden) en zichzelf beheert zonder professioneel beheerkantoor. Die zelfbeherende VvE's zijn de primaire doelgroep: zij werken nu met Excel, een gedeelde Dropbox en een bankrekening waarvan niemand precies weet wat het reservefonds is.

De applicatie moet:

- **Meerdere VvE's naast elkaar** bedienen (multi-tenant), beheerd door één applicatiebeheerder.
- Per VvE de **financiële situatie** volledig en controleerbaar vastleggen: begroting, maandbijdragen, facturen, betalingen, reservefonds, jaarrekening.
- De **VvE-stukken** (splitsingsakte, reglementen, notulen, jaarrekeningen, polissen, offertes) veilig ontsluiten aan de juiste doelgroep.
- **Bankafschriften inlezen** (CAMT.053, MT940, CSV) en automatisch afletteren tegen openstaande posten.
- **SEPA-incassobestanden genereren** (pain.008) inclusief mandaatbeheer en stornoverwerking.
- Een **meerjarenonderhoudsplan (MJOP)** voeren en daaruit de noodzakelijke reservefondsdotatie afleiden.
- Zowel een **nieuwe VvE vanaf nul** kunnen inrichten (bijdrage berekend uit begroting via breukdeel of m²) als een **bestaande VvE overnemen** met reeds vastgestelde, vaste maandbedragen en een openingsbalans.

**Wat het expliciet níet is:** geen volledig boekhoudpakket voor derden, geen makelaars-/verhuurplatform, geen vervanging van de notaris. Het is een VvE-beheersysteem met een boekhoudkundig correcte kern.

---

## 2. Domeinwoordenlijst (bindend)

| Begrip | Betekenis in dit systeem |
|---|---|
| **VvE** | Vereniging van Eigenaren; de tenant. Alles is aan een VvE gekoppeld. |
| **Appartementsrecht / wooneenheid** | Het juridische eigendomsobject: woning, parkeerplaats, berging of bedrijfsruimte. Kosten en stemmen hangen aan de eenheid, niet aan de persoon. |
| **Splitsingsakte** | Notariële akte die het gebouw splitst; bevat breukdelen, bestemming en het van toepassing zijnde modelreglement. Leidend document. |
| **Breukdeel** | Aandeel van een eenheid in de gemeenschap, als teller/noemer (bijv. `125/1000`). Standaard verdeelsleutel voor kosten én meestal voor stemmen. |
| **Modelreglement** | MR 1973 / 1983 / 1992 / 2006 / 2017. Bepaalt oproeptermijnen, quorum, boeterentes. Per VvE vast te leggen; beïnvloedt defaults. |
| **Verdeelsleutel** | Regel waarmee een kostenpost over eenheden wordt verdeeld: breukdeel, vierkante meters, gelijke delen, stemmen, of handmatig (met uitsluitingen). |
| **Voorschotbijdrage / VvE-bijdrage** | Periodiek (meestal maandelijks) vooruitbetaald bedrag per eenheid. Bestaat uit een exploitatiedeel en een reservefondsdeel. |
| **Exploitatierekening** | Betaalrekening voor lopende kosten. |
| **Reservefonds** | Wettelijk verplicht spaarfonds voor groot onderhoud, op een aparte rekening. |
| **MJOP** | Meerjarenonderhoudsplan: bouwdelen, cyclus, hoeveelheid, eenheidsprijs, uitvoeringsjaar, geïndexeerd. |
| **Begroting** | Per boekjaar vastgestelde raming van baten en lasten; basis voor de bijdragen. |
| **Afrekening servicekosten** | Jaarlijkse verrekening werkelijke kosten vs. betaalde voorschotten, per eenheid. |
| **ALV** | Algemene Ledenvergadering; het hoogste orgaan. Stelt begroting, jaarrekening, MJOP en dotatie vast. |
| **Bestuur** | Uitvoerend orgaan (voorzitter/penningmeester/secretaris of één bestuurder). |
| **Beheerder** | In dit systeem: de gebruiker die één VvE administratief beheert. Vaak tevens eigenaar en penningmeester. |
| **Kascommissie** | Controleert de jaarrekening; heeft leesrechten op de volledige financiële administratie. |
| **Machtiging (SEPA-mandaat)** | Doorlopende incassomachtiging van een eigenaar, met uniek kenmerk en ondertekendatum. |
| **Storno / R-transactie** | Teruggeboekte incasso, met reden (bijv. `AM04` saldo ontoereikend, `MD01` geen mandaat). |
| **Nota** | Vordering op een eenheid: periodieke bijdrage, afrekening, eenmalige heffing, boete of rente. |
| **Eigenaarswissel** | Overdracht van het appartementsrecht; historie blijft, verantwoordelijkheid splitst per datum. |

---

## 3. Rollen, rechten en toegang

### 3.1 Rollen

| Rol | Scope | Kern |
|---|---|---|
| **Applicatiebeheerder** (superadmin) | Systeembreed | Maakt VvE's aan, maakt/reset het beheerdersaccount per VvE, ziet systeemlogboek en mailwachtrij. **Geen** inhoudelijke toegang tot financiële detaildata van een VvE tenzij expliciet "impersonatie met logging" wordt gebruikt. |
| **VvE-beheerder** | Eén VvE | Volledige functionele rechten binnen die VvE: eenheden, eigenaren, financiën, documenten, MJOP, incasso, vergaderingen. |
| **Bestuurslid** | Eén VvE | Als beheerder, minus: gebruikersbeheer, incassobestanden definitief genereren, boekjaar afsluiten (configureerbaar per VvE). |
| **Penningmeester** | Eén VvE | Financiële rechten volledig; geen gebruikersbeheer. |
| **Kascommissielid** | Eén VvE, tijdelijk | Leesrechten op volledige financiële administratie van het te controleren boekjaar. Automatisch aflopend. |
| **Eigenaar** | Eigen eenhe(i)d(en) | Eigen nota's, betaalhistorie, eigen gegevens, machtiging afgeven, openbare documenten, ALV-stukken, meldingen indienen, stemmen. |
| **Bewoner/huurder** | Eén eenheid | Alleen mededelingen, huisregels en meldingen. Geen financiële gegevens. |

Een persoon kan meerdere rollen hebben, in meerdere VvE's. Rollen zijn **tijdgebonden** (`start_datum`, `eind_datum`).

### 3.2 Autorisatieprincipes (hard)

- **Deny by default.** Elke controller-actie declareert expliciet welk recht vereist is; ontbreekt de declaratie, dan weigert de router.
- **Tenant-scoping is niet optioneel.** Elke query op een tenant-tabel gaat door een repository die `vve_id` afdwingt uit de sessiecontext. Er is één centrale plek waar `vve_id` wordt bepaald; controllers krijgen het nooit uit de request-parameters zonder verificatie dat de gebruiker een actieve rol in die VvE heeft.
- **Objecttoegang wordt per record gecontroleerd**, niet alleen per route. Een eigenaar die `/nota/1234` opvraagt krijgt 404 (niet 403) als die nota bij een andere eenheid hoort.
- **Bestanden gaan nooit rechtstreeks via de webserver.** Uploads staan buiten de documentroot; downloads lopen via een controller die rol, VvE en zichtbaarheid controleert en de stream met `Content-Disposition` teruggeeft.
- Elke rechtenwijziging, elke financiële mutatie en elke inzage in persoonsgegevens komt in het **auditlog**.

### 3.3 Accountlevenscyclus

**Aanmaken beheerder (door applicatiebeheerder):**
1. Applicatiebeheerder maakt VvE aan en voert e-mailadres + naam van de beheerder in.
2. Systeem maakt account, genereert een wachtwoord van 16 tekens uit een CSPRNG (`random_bytes`), zet `wachtwoord_wijzigen_verplicht = 1` en `wachtwoord_verloopt_op = now + 14 dagen`.
3. Systeem mailt het wachtwoord in een **aparte mail** van de mail met de inlog-URL en gebruikersnaam.
4. Knop **"Opnieuw wachtwoord versturen"** herhaalt stap 2–3: genereert een nieuw wachtwoord, invalideert het oude en alle actieve sessies van dat account, en mailt opnieuw. Gelogd in het auditlog met wie het deed.

> **Aanbevolen variant, standaard aan:** stuur in plaats van een wachtwoord een **eenmalige instellink** (token van 32 bytes, hash in de database, geldig 72 uur, één keer bruikbaar). De gebruiker kiest zelf het wachtwoord. De knop heet dan "Nieuwe instellink versturen". Beide varianten moeten werken; de instelling `auth.uitnodiging_methode = link|wachtwoord` bepaalt welke actief is. Reden: een gemaild wachtwoord blijft onbeperkt in de mailbox staan.

**Uitnodigen eigenaren (door VvE-beheerder):**
1. Beheerder maakt een wooneenheid aan en voegt één of meer e-mailadressen toe (meerdere eigenaren per eenheid is normaal: partners, of een eenheid in gezamenlijk bezit).
2. Per adres ontstaat een **uitnodiging** met token. Bestaat het e-mailadres al als persoon (bijv. eigenaar in een andere VvE), dan wordt de bestaande persoon gekoppeld en krijgt die een "u bent toegevoegd aan VvE X"-mail in plaats van een registratielink.
3. De uitnodiging vervalt na 30 dagen en is opnieuw te versturen. Status per eenheid zichtbaar: *niet uitgenodigd / uitgenodigd / actief / geen e-mail bekend*.
4. Een eenheid **zonder** e-mailadres moet volledig kunnen functioneren (post per brief); het systeem genereert dan PDF's voor postverzending en markeert de eenheid als `communicatie_wijze = post`.

**Overige flows:** wachtwoord vergeten (token, 1 uur geldig, altijd dezelfde bevestigingstekst ongeacht of het adres bestaat), wachtwoord wijzigen, e-mailadres wijzigen met verificatie op het nieuwe adres, account deactiveren bij eigenaarswissel (nooit verwijderen — historie).

---

## 4. Functionele modules

Per module: doel, user stories en acceptatiecriteria (AC). AC zijn testbaar en vormen de basis voor de geautomatiseerde tests.

### M1 — VvE-beheer (applicatiebeheerder)

**Doel:** VvE's aanmaken en het beheerdersaccount beheren.

Vast te leggen per VvE: naam, KvK-nummer, adres/plaats, datum splitsingsakte, modelreglement (keuzelijst), totaal aantal breukdelen (noemer), boekjaar (startmaand, standaard januari), herbouwwaarde (voor de wettelijke reservefondsnorm), IBAN exploitatie, IBAN reserve, SEPA-incassant-ID, logo, standaard betaaltermijn, aanmaningsinstellingen, status (actief/gearchiveerd).

- **AC1.1** Applicatiebeheerder kan een VvE aanmaken met minimaal naam en boekjaarinstelling; overige velden zijn later aanvulbaar.
- **AC1.2** Bij het aanmaken van een VvE wordt verplicht één beheerderaccount aangemaakt (e-mail + naam).
- **AC1.3** De knop "Opnieuw wachtwoord versturen" genereert een nieuw wachtwoord, ongeldigt het vorige én alle lopende sessies, en verstuurt een mail. De actie is zichtbaar in het auditlog met tijdstip en uitvoerder.
- **AC1.4** Een gearchiveerde VvE is niet meer benaderbaar voor haar gebruikers, maar data blijft bewaard en exporteerbaar.
- **AC1.5** De applicatiebeheerder ziet een overzicht met per VvE: aantal eenheden, laatste login beheerder, openstaand debiteurensaldo, saldo reservefonds, status boekjaar.

### M2 — Wooneenheden en eigenaren

**Doel:** de juridische structuur van de VvE vastleggen.

Per eenheid: interne code/index (bijv. `A-12`), type (woning/parkeerplaats/berging/bedrijfsruimte/gemeenschappelijk), adres + huisnummer + toevoeging + postcode, kadastrale aanduiding, oppervlakte in m² (2 decimalen), breukdeel (teller/noemer), aantal stemmen, bouwlaag, gebouw/blok, actief vanaf/tot.

- **AC2.1** De beheerder maakt eerst zijn **eigen** eenheid aan en wordt daaraan automatisch als eigenaar gekoppeld.
- **AC2.2** De beheerder kan eenheden voor buren aanmaken en per eenheid nul of meer e-mailadressen opgeven; per adres wordt een uitnodiging verzonden.
- **AC2.3** Het systeem waarschuwt (blokkeert niet) als de som van de breukdelen ≠ de noemer, en toont het verschil.
- **AC2.4** Meerdere eigenaren per eenheid zijn mogelijk, met een aandeel per eigenaar (default 50/50 bij twee) en één aangemerkt als **primair contact** voor facturatie en incasso.
- **AC2.5** **Eigenaarswissel:** bij invoer van een leveringsdatum wordt het oude eigenaarschap op `eind_datum = leveringsdatum - 1 dag` gezet en het nieuwe op `start_datum = leveringsdatum`. Historische nota's, betalingen en stemmen blijven aan de oude eigenaar gekoppeld. Het systeem toont een verrekenoverzicht (naar rato van de periode) dat naar de notaris gestuurd kan worden, en signaleert openstaande posten van de verkoper.
- **AC2.6** Huurders/bewoners kunnen per eenheid worden vastgelegd met beperkte toegang, zonder financiële rechten.
- **AC2.7** Bulk-import van eenheden en eigenaren via CSV/XLSX, met voorbeeldbestand, validatie vooraf en een dry-run-rapport.

### M3 — Documentenbeheer (VvE-stukken)

**Doel:** alle VvE-stukken centraal, versiebeheerd en met correcte zichtbaarheid.

Vaste categorieën: `splitsingsakte`, `splitsingstekening`, `modelreglement`, `huishoudelijk_reglement`, `notulen`, `agenda_alv`, `jaarrekening`, `begroting`, `mjop`, `verzekeringspolis`, `contract`, `offerte`, `factuur`, `correspondentie`, `bouwkundig_rapport`, `energielabel`, `overig`.

- **AC3.1** Upload van PDF, JPG, PNG, DOCX, XLSX; max 25 MB per bestand (configureerbaar). MIME wordt server-side bepaald (`finfo`), niet uit de bestandsnaam of de client.
- **AC3.2** Zichtbaarheid per document: `alle_leden` / `bestuur` / `alleen_beheerder`. Huurders zien uitsluitend documenten die expliciet als `huisregels`-zichtbaar zijn gemarkeerd.
- **AC3.3** Versiebeheer: een nieuwe versie van hetzelfde document blijft aan de vorige gekoppeld; oude versies zijn zichtbaar voor bestuur, en gemarkeerd als "vervallen".
- **AC3.4** Documenten kunnen aan een boekjaar, een ALV, een MJOP-activiteit, een leverancier of een factuur gekoppeld worden.
- **AC3.5** Volledig-tekstzoeken op titel, categorie, jaar en tags. (PDF-tekstextractie is optioneel, fase 7.)
- **AC3.6** Een eigenaar kan de "VvE-map" downloaden als ZIP met alle voor hem zichtbare stukken — praktisch bij verkoop van de woning.
- **AC3.7** Bestandsnamen op schijf zijn willekeurig (UUID); de oorspronkelijke naam staat in de database. Bestanden staan buiten de documentroot.

### M4 — Verdeelsleutels

**Doel:** correct kosten toewijzen; dit is de kern waar de meeste VvE-software te simplistisch is.

Sleuteltypen: `breukdeel`, `vierkante_meters`, `gelijke_delen`, `stemmen`, `handmatig`.

- **AC4.1** Per VvE zijn meerdere sleutels vast te leggen (bijv. "Algemeen (breukdeel)", "Lift (alleen bouwlaag ≥ 1)", "Warmte (m²)", "Parkeerdek (alleen parkeerplaatsen)").
- **AC4.2** Bij `handmatig` legt de beheerder per eenheid een gewicht vast (0 = uitgesloten). Bij de andere typen is een **uitsluitingslijst** mogelijk: eenheden met gewicht 0 doen niet mee en het restant wordt over de overige eenheden verdeeld volgens het gekozen type.
- **AC4.3** Elke begrotingsregel/kostenpost verwijst naar precies één verdeelsleutel.
- **AC4.4** Een sleutel toont altijd een voorbeeldberekening: "€ 12.000 verdeeld → eenheid A-12 (125/1000): € 1.500,00".
- **AC4.5** Sleutels zijn **gehistoriseerd**: wijzigen na vaststelling van een begroting maakt een nieuwe versie aan; reeds gegenereerde nota's veranderen nooit met terugwerkende kracht.

### M5 — Begroting en maandbijdragen

**Doel:** van begroting naar bedrag per eenheid per maand — of, bij overname, van bestaande vaste bedragen naar een werkende administratie.

Drie bijdragemethoden per boekjaar, per VvE instelbaar:

1. **`uit_begroting`** — per begrotingsregel een bedrag + verdeelsleutel; het systeem sommeert per eenheid en deelt door de periodiciteit.
2. **`vast_bedrag`** — per eenheid een handmatig vastgelegd periodebedrag (overname bestaande VvE). Het systeem toont wél de begroting en signaleert het verschil tussen de som van de vaste bedragen en de begroting ("dekkingstekort € 1.240 per jaar").
3. **`vierkante_meters`** — totaalbedrag gedeeld door totaal m², maal m² per eenheid. (Feitelijk methode 1 met één regel en de m²-sleutel; wel als aparte snelle wizard aanbieden.)

- **AC5.1** Een begroting kent statussen `concept` → `voorgesteld_alv` → `vastgesteld` → `gesloten`. Alleen vanuit `vastgesteld` mogen nota's worden gegenereerd.
- **AC5.2** De bijdrage splitst altijd in **exploitatiedeel** en **reservefondsdeel**; beide worden afzonderlijk geboekt en getoond.
- **AC5.3** Het systeem toont per eenheid het nieuwe bedrag naast het oude, met verschil in € en %, vóór definitief vaststellen.
- **AC5.4** Afronding volgens §5.2 (grootste-restmethode); de som van de eenheidsbedragen is **exact** gelijk aan het te verdelen bedrag, tot op de cent.
- **AC5.5** Tussentijdse wijzigingen (extra heffing, gewijzigde bijdrage per 1 juli) zijn mogelijk met ingangsdatum; reeds verstuurde nota's blijven ongewijzigd.
- **AC5.6** Bij overname van een bestaande VvE kan de beheerder een **openingsbalans** invoeren (saldi bankrekeningen, reservefonds, openstaande debiteuren per eenheid, crediteuren) zonder de voorgaande jaren te hoeven boeken.
- **AC5.7** Een **conceptbegroting voor de ALV** is als PDF te exporteren met kolommen: realisatie vorig jaar, begroting lopend jaar, voorstel volgend jaar, en de resulterende maandbijdrage per eenheid.

### M6 — Nota's, betalingen en debiteurenbeheer

- **AC6.1** Nota's worden per periode gegenereerd (maand/kwartaal/jaar) voor alle actieve eenheden, met uniek doorlopend nummer per VvE per boekjaar (`2026-0001`).
- **AC6.2** Elke nota vermeldt: eenheid, periode, specificatie exploitatie/reservefonds, vervaldatum, betaalwijze (incasso of overboeking), en bij overboeking een **betalingskenmerk** dat automatisch afletteren mogelijk maakt.
- **AC6.3** Handmatige betalingen zijn te registreren en te koppelen aan één of meer nota's; deelbetalingen en vooruitbetalingen worden ondersteund (een vooruitbetaling blijft als creditsaldo op de eenheid staan en wordt automatisch met de eerstvolgende nota verrekend).
- **AC6.4** Debiteurenoverzicht per eenheid en per VvE, met ouderdomsanalyse (0–30 / 31–60 / 61–90 / 90+ dagen).
- **AC6.5** **Aanmaningstraject** in drie stappen (herinnering / aanmaning / ingebrekestelling-WIK), per stap configureerbare termijn en kosten. Bij consumenten wordt de wettelijke veertiendagenbrief correct geformuleerd (§5.5).
- **AC6.6** Boeterente en incassokosten worden berekend volgens de instellingen van de VvE (modelreglement-boete of wettelijke rente) en als aparte nota vastgelegd, nooit als aanpassing van de oorspronkelijke nota.
- **AC6.7** Een eigenaar ziet in het portaal zijn nota's, betaalstatus en een downloadbare PDF, plus een jaaropgave.
- **AC6.8** Dossier per debiteur: alle nota's, betalingen, aanmaningen, correspondentie en aantekeningen chronologisch, exporteerbaar als PDF voor een incassobureau of de deurwaarder.

### M7 — Bankrekeningen, importeren en afletteren

- **AC7.1** Import van **CAMT.053 XML**, **MT940** en **CSV** (met kolommapping per bank, met kant-en-klare profielen voor ING, Rabobank, ABN AMRO, bunq, Knab, Triodos, ASN, SNS, Regiobank).
- **AC7.2** **Duplicaatdetectie** op een hash van (rekening, boekdatum, bedrag, tegenrekening, omschrijving, volgnummer). Twee keer hetzelfde bestand importeren voegt niets toe en meldt dat expliciet.
- **AC7.3** Na import controleert het systeem de **saldocontinuïteit**: beginsaldo van het bestand moet gelijk zijn aan het eindsaldo van de vorige import; anders een blokkerende waarschuwing met het gat.
- **AC7.4** **Automatisch afletteren**, in deze volgorde:
   1. Betalingskenmerk of nota-nummer in de omschrijving → exacte match.
   2. SEPA End-to-End-ID uit een eigen incassobatch → match op incassopost.
   3. Tegenrekening-IBAN → bekende eigenaar/eenheid → open nota met exact hetzelfde bedrag.
   4. Tegenrekening-IBAN → bekende eigenaar → oudste open nota's, FIFO afboeken (bij afwijkend bedrag alleen voorstellen, niet automatisch boeken).
   5. Tegenrekening-IBAN → bekende leverancier → voorgestelde kostenrekening uit de boekingsregels.
- **AC7.5** Alles wat niet zeker gematcht kan worden komt in een **werkbak** met voorstellen; de gebruiker bevestigt of corrigeert. Een handmatige correctie kan als **boekingsregel** worden opgeslagen ("bevat 'Vitens' → grootboek 4310 Water") voor volgende keren.
- **AC7.6** Overboekingen tussen de eigen exploitatie- en reserverekening worden als één interne mutatie herkend en niet dubbel als kosten/opbrengst geboekt.
- **AC7.7** Bankmutaties zijn nooit bewerkbaar na import; correcties gebeuren via de koppeling of via een memoriaalboeking.

### M8 — SEPA-incasso

- **AC8.1** **Mandaatbeheer** per eenheid/eigenaar: uniek machtigingskenmerk, IBAN, tenaamstelling, ondertekendatum, type (CORE/B2B), status (`actief`/`ingetrokken`/`verlopen`), en de indicator of de eerste incasso is uitgevoerd.
- **AC8.2** Een eigenaar kan in het portaal digitaal machtigen; het systeem legt datum, tijdstip, IP-adres en de exacte machtigingstekst vast als bewijs, en stuurt een bevestigingsmail.
- **AC8.3** Genereren van **pain.008.001.02** (met optie 001.08) met correcte `CdtrSchmeId` (incassant-ID), `SeqTp` (`FRST`/`RCUR`/`OOFF`/`FNAL`), `ReqdColltnDt` en unieke `EndToEndId` per post (`{vve}-{nota}-{poging}`).
- **AC8.4** Het gegenereerde bestand wordt gevalideerd tegen het XSD vóór aanbieding; een ongeldig bestand wordt niet opgeslagen.
- **AC8.5** **Vooraankondiging (pre-notificatie)**: nota's die per incasso lopen vermelden bedrag en incassodatum en worden minimaal het ingestelde aantal dagen (default 14) vóór afschrijving verstuurd. Het systeem blokkeert een incassodatum die deze termijn schendt.
- **AC8.6** **Uitsluitingen:** eenheden zonder actief mandaat, met een incassoblokkade, of met een bedrag ≤ € 0 worden overgeslagen, met reden zichtbaar in het batchrapport.
- **AC8.7** **Stornoverwerking:** stornoberichten (pain.002 / camt.054, of handmatig vanuit het bankafschrift) heropenen de nota, registreren reden en datum en verhogen de stornoteller. Na 2 stornocodes uit de categorie "geen dekking/geen mandaat" wordt het mandaat automatisch op `incasso_geblokkeerd` gezet en schakelt de eenheid over op overboeking.
- **AC8.8** Wijziging van IBAN of van het incassant-ID leidt tot een **mandaatwijziging** met de juiste `AmdmntInf`-velden in het volgende bestand.
- **AC8.9** Een batch is `concept` → `gegenereerd` → `ingediend` → `verwerkt`; een gegenereerde batch is niet meer wijzigbaar, alleen te annuleren (met reden) vóór indiening.

### M9 — Grootboek, jaarrekening en afrekening

De boekhoudkern is **dubbel boekhouden**, maar de UI toont het alleen aan wie erom vraagt.

- **AC9.1** Standaard grootboekschema voor VvE's wordt bij het aanmaken van een VvE gekopieerd (zie §5.7) en is daarna per VvE aanpasbaar.
- **AC9.2** Elke financiële gebeurtenis (nota, betaling, bankmutatie, incasso, afschrijving, memoriaal) genereert een journaalpost waarvan debet = credit. Een onbalans is technisch onmogelijk: de boekingsservice weigert de transactie.
- **AC9.3** Boekjaar afsluiten vergrendelt alle boekingen in dat jaar, genereert de eindbalans en boekt het resultaat naar het eigen vermogen respectievelijk het reservefonds.
- **AC9.4** **Jaarrekening**: balans + staat van baten en lasten, met vergelijkende kolom vorig jaar en begroting, exporteerbaar als PDF en XLSX.
- **AC9.5** **Afrekening servicekosten per eenheid**: werkelijke kosten per verdeelsleutel toegerekend, minus betaalde voorschotten = te vorderen of te restitueren bedrag. Genereert automatisch nota's of creditnota's na goedkeuring in de ALV.
- **AC9.6** Bij een eigenaarswissel binnen het boekjaar wordt de afrekening naar rato over de dagen verdeeld tussen oude en nieuwe eigenaar, met een expliciet overzicht van beide delen.
- **AC9.7** **Kascommissie-modus**: een schermset met alle boekingen, brondocumenten en banksaldi van het te controleren jaar, met een aftekenfunctie en een genereerbare verklaring.
- **AC9.8** Auditspoor: vanuit elke regel in de jaarrekening kan doorgeklikt worden naar de onderliggende boekingen en van daaruit naar het brondocument (factuur-PDF, bankmutatie).

### M10 — MJOP en reservefonds

- **AC10.1** Per MJOP: startjaar, looptijd (default 15, minimaal 10), indexpercentage, status en vaststellings-ALV.
- **AC10.2** Per bouwelement: naam, categorie (dak, gevel, kozijnen, schilderwerk, installaties, lift, terrein, …), hoeveelheid + eenheid, eenheidsprijs, cyclus in jaren, jaar laatste uitvoering, conditiescore volgens NEN 2767 (1–6), en de bijbehorende grootboekrekening.
- **AC10.3** Het systeem genereert per element de geplande activiteiten over de looptijd, geïndexeerd naar het uitvoeringsjaar, en toont een jaarstaat en een grafiek.
- **AC10.4** **Reservefondsprognose**: per jaar beginsaldo + dotatie + rente − uitgaven = eindsaldo. Het systeem berekent de **benodigde jaarlijkse dotatie** zodat het saldo gedurende de hele looptijd nooit onder een instelbare ondergrens komt, en toont die naast de huidige dotatie.
- **AC10.5** **Wettelijke minimumtoets:** waarschuw als de jaardotatie lager is dan het maximum van (a) 0,5% van de herbouwwaarde en (b) het uit het MJOP volgende bedrag, met verwijzing naar de wettelijke grondslag. Alleen een waarschuwing — een VvE mag hier bij ALV-besluit van afwijken, en het systeem legt dat besluit vast.
- **AC10.6** Een uitgevoerde activiteit wordt afgemeld met werkelijk bedrag, datum, leverancier en factuur; het element schuift automatisch een cyclus door.
- **AC10.7** Scenario's: een kopie van het MJOP met gewijzigde aannames (index, uitstel, duurzaamheidsmaatregelen) naast het vastgestelde plan, om in de ALV te vergelijken.
- **AC10.8** Import van een extern MJOP uit XLSX met kolommapping.

### M11 — Vergaderingen, besluiten en stemmen

- **AC11.1** ALV plannen met datum, locatie, type (`alv`/`bijzondere_alv`/`bestuursvergadering`) en agenda met genummerde punten en bijlagen.
- **AC11.2** Oproeping wordt gegenereerd en verstuurd; het systeem bewaakt de oproeptermijn uit het modelreglement (default 15 dagen) en waarschuwt bij overschrijding.
- **AC11.3** Presentie en **volmachten** worden geregistreerd; het systeem berekent het aanwezige aantal stemmen en toetst het quorum, inclusief de tweede-vergaderingsregeling.
- **AC11.4** Per stempunt worden stemmen geteld op basis van het stemgewicht per eenheid; het systeem toont voor/tegen/onthouding, de vereiste meerderheid (gewone meerderheid, 2/3, of unaniem) en de uitslag.
- **AC11.5** Een eigenaar met een openstaande schuld kan door de beheerder als stemgerechtigd of niet-stemgerechtigd worden gemarkeerd conform het reglement; de reden wordt vastgelegd.
- **AC11.6** Notulen worden gekoppeld; genomen besluiten komen in een doorzoekbaar **besluitenregister** dat losstaat van de notulen (praktisch bij verkoop en bij discussie jaren later).
- **AC11.7** Een besluit kan gekoppeld worden aan een begroting, MJOP, extra heffing of dotatiewijziging, waardoor de financiële module weet op welk besluit een bedrag berust.

### M12 — Onderhoudsmeldingen en leveranciers

- **AC12.1** Een eigenaar of bewoner meldt een probleem met categorie, locatie, omschrijving en maximaal 5 foto's.
- **AC12.2** Statusflow: `nieuw` → `in_behandeling` → `opdracht_verstrekt` → `afgerond` / `afgewezen`, met toewijzing aan een bestuurslid en een leverancier, en een tijdlijn met reacties.
- **AC12.3** Melder ontvangt een mail bij statuswijziging; het bestuur ziet een werkbak met SLA-signalering op ouderdom.
- **AC12.4** Leveranciersregister met contactgegevens, IBAN, KvK, contracten (bedrag per jaar, looptijd, opzegtermijn) en een signalering **90 dagen vóór het verstrijken van de opzegtermijn**.
- **AC12.5** Register van **verplichte keuringen en verzekeringen**: liftkeuring, brandmeldinstallatie, legionellabeheersing, NEN 3140, opstalverzekering, aansprakelijkheid, bestuurdersaansprakelijkheid, rechtsbijstand — met vervaldatum, polisdocument en herinneringen op T-60 en T-14 dagen.
- **AC12.6** Facturen van leveranciers worden vastgelegd met factuurnummer, datum, bedrag, grootboekrekening, betaalstatus en PDF, en zijn koppelbaar aan een MJOP-activiteit of een melding.

### M13 — Communicatie

- **AC13.1** Mededelingen/nieuwsberichten per VvE, met doelgroep (alle leden / eigenaren / bewoners) en optionele e-mailverzending.
- **AC13.2** Alle uitgaande mail loopt via een **wachtrij** met status, aantal pogingen en foutmelding; een falende SMTP-verbinding mag nooit een gebruikersactie laten mislukken.
- **AC13.3** Mailsjablonen zijn per VvE aanpasbaar (afzendernaam, logo, ondertekening) met vaste placeholders; een sjabloonfout mag het versturen niet blokkeren (fallback naar het standaardsjabloon).
- **AC13.4** Serie-verzending (bijv. alle nota's van een maand) is één handeling met een voortgangsrapport en een lijst van eenheden die per post moeten.
- **AC13.5** Alle verzonden mail per ontvanger terug te vinden in het dossier, inclusief het verzonden PDF-bestand — bewijslast bij aanmaningen.

### M14 — Portaal voor de eigenaar

Eén overzichtelijk startscherm met: mijn eenheid, mijn maandbijdrage (gesplitst), openstaand saldo, laatste betalingen, mijn machtiging, komende ALV met stukken, laatste mededelingen, actieve meldingen, en de documentmap.

- **AC14.1** Volledig bruikbaar op mobiel (de meeste eigenaren openen dit op de telefoon).
- **AC14.2** Een eigenaar met eenheden in meerdere VvE's kiest bij inloggen de VvE en kan schakelen zonder opnieuw in te loggen.
- **AC14.3** Eigen gegevens (naam, telefoon, correspondentieadres, communicatievoorkeur) zelf te wijzigen; e-mailwijziging met verificatie.
- **AC14.4** Downloadbare jaaropgave met de betaalde bijdragen — nodig voor de belastingaangifte bij verhuurde eenheden.

---

## 5. Bedrijfsregels (bindend)

### 5.1 Geld en rekenen

- Alle bedragen: `BIGINT` in **eurocenten**, kolomnaam eindigt op `_cent`. Nooit `FLOAT`/`DOUBLE`. `DECIMAL` alleen voor percentages en oppervlaktes.
- Percentages: `DECIMAL(7,4)` (bijv. `2.5000` = 2,5%).
- Oppervlakte: `DECIMAL(10,2)` m².
- Breukdelen: als integers `breukdeel_teller` / `breukdeel_noemer`. Nooit vooraf naar een percentage afronden.
- Rekenen gebeurt in de domeinlaag met integers; conversie naar tekst uitsluitend in de presentatielaag (`nl-NL`, punt als duizendtal, komma als decimaal, `€ 1.234,56`).

### 5.2 Afronding en verdeling (grootste-restmethode)

Bij het verdelen van een bedrag `T` (in centen) over eenheden met gewichten `w_i`:

1. `exact_i = T * w_i / Σw` (rationaal, niet afronden).
2. `basis_i = floor(exact_i)`.
3. `rest = T − Σ basis_i`.
4. Sorteer de eenheden aflopend op de fractionele rest `exact_i − basis_i`; bij gelijke rest op eenheid-ID oplopend (deterministisch).
5. Ken aan de eerste `rest` eenheden elk 1 cent extra toe.

**Invariant, af te dwingen met een assertie én een test: `Σ toegewezen_i == T`, altijd.** Dit geldt voor bijdragen, afrekeningen, MJOP-toerekening en incassobatches.

### 5.3 Bijdrageberekening

Per eenheid `e` en boekjaar `j`:

```
jaarbedrag(e) = Σ over begrotingsregels r:  verdeel(bedrag_r, sleutel_r)[e]
periodebedrag(e) = verdeel(jaarbedrag(e), gelijke_delen over perioden)
```

De tweede verdeling is opnieuw de grootste-restmethode over 12 (of 4, of 1) perioden, zodat de som van de perioden exact het jaarbedrag is. Het verschil van enkele centen valt dan in de eerste maanden, niet als sluitpost in december.

Splitsing exploitatie/reservefonds: elke begrotingsregel is gemarkeerd als `reservefonds = 0|1`; de twee sommen worden apart bijgehouden en apart geboekt.

Bij methode `vast_bedrag` is `periodebedrag(e)` handmatig ingevoerd en wordt het jaarbedrag daaruit afgeleid; de begroting dient dan alleen ter vergelijking en dekkingsanalyse.

### 5.4 Reservefonds

- Wettelijk minimum per jaar = `max(0,5% × herbouwwaarde, dotatie volgens MJOP)`. MJOP mag niet ouder zijn dan 5 jaar om als grondslag te dienen — signaleer dat.
- Het reservefonds staat op een **aparte rekening**; het systeem waarschuwt als het geboekte reservefondssaldo afwijkt van het banksaldo van de reserverekening.
- Onttrekking aan het reservefonds vereist een gekoppeld ALV-besluit; zonder besluit is het een waarschuwing bij het boeken, geen blokkade.

### 5.5 Debiteuren, rente en kosten

- Vervaltermijn default 14 dagen na factuurdatum; bij incasso is de vervaldag de incassodatum.
- **Traject:** herinnering (T+7 na verval, kosteloos) → aanmaning (T+21, met de wettelijke veertiendagenbrief voor consumenten waarin expliciet de incassokosten worden aangezegd) → ingebrekestelling (T+45) → dossier gereed voor incasso/deurwaarder.
- Incassokosten volgens de wettelijke staffel (WIK): 15% over de eerste € 2.500, met een minimum van € 40. Rente: wettelijke rente óf de reglementaire boete (veel modelreglementen kennen een boete per maand plus een opslag) — instelbaar per VvE, met de gekozen grondslag zichtbaar op de aanmaning.
- Verjaringstermijn van VvE-bijdragen is 5 jaar; signaleer openstaande posten ouder dan 4,5 jaar.
- Bij eigendomsoverdracht: de nieuwe eigenaar is naast de oude hoofdelijk aansprakelijk voor de bijdragen over het lopende en het voorafgaande boekjaar (art. 5:122 lid 3 BW). Het systeem toont dit bij een eigenaarswissel met openstaande posten en genereert de opgave voor de notaris.

### 5.6 SEPA-regels

- Machtigingskenmerk: uniek per incassant, maximaal 35 tekens, alleen `A-Z a-z 0-9 + ? / - : ( ) . , '` en spatie. Formaat: `VVE{vve_id}-{eenheid_code}-{volgnr}`.
- `EndToEndId`: uniek, maximaal 35 tekens, formaat `N{nota_nummer}-{poging}`.
- Aanlevertermijn vóór incassodatum: instelbaar per VvE (default 2 werkdagen; sommige banken hanteren afwijkende cut-offs). Het systeem rekent met werkdagen en de Nederlandse feestdagen.
- `SeqTp`: `FRST` bij de eerste incasso op een mandaat, daarna `RCUR`; `FNAL` bij de laatste, `OOFF` bij een eenmalige. Instelling `sepa.altijd_rcur` (default aan) voor banken die geen FRST meer vereisen.
- Vooraankondigingstermijn default 14 kalenderdagen, per VvE verlaagbaar mits in het reglement of de machtigingsvoorwaarden vastgelegd.
- Terugboekrecht consument: 8 weken zonder opgaaf van reden, 13 maanden bij een ongeldig mandaat. Bewaar mandaatbewijs daarom minimaal 14 maanden na de laatste incasso.
- Één batch bevat posten met dezelfde incassodatum en hetzelfde mandaattype; splits automatisch als dat niet zo is.

### 5.7 Standaard grootboekschema (kopiëren bij aanmaken VvE)

```
BALANS
1000  Kas
1100  Bank exploitatierekening
1150  Bank reserverekening
1300  Debiteuren (VvE-bijdragen)
1350  Te ontvangen bedragen
1600  Crediteuren
1700  Vooruitontvangen bijdragen
1750  Nog te betalen kosten
0500  Algemene reserve / exploitatieoverschot
0600  Reservefonds groot onderhoud
0700  Bestemmingsreserve (per project)

LASTEN
4100  Onderhoud gebouw – dagelijks
4110  Onderhoud installaties
4120  Onderhoud lift
4130  Onderhoud groen en terrein
4150  Schoonmaak
4200  Verzekering opstal
4210  Verzekering aansprakelijkheid
4220  Verzekering bestuurdersaansprakelijkheid
4230  Rechtsbijstand
4300  Elektra gemeenschappelijk
4310  Water
4320  Gas / warmte
4400  Beheerkosten / administratie
4410  Bankkosten
4420  Kosten ALV en vergaderingen
4430  Contributies en abonnementen
4440  Advies- en juridische kosten
4500  Belastingen en heffingen
4900  Onvoorzien
4950  Dotatie reservefonds

BATEN
8100  Voorschotbijdragen exploitatie
8150  Voorschotbijdragen reservefonds
8200  Rente-inkomsten
8300  Doorbelaste kosten
8400  Boetes en incassokosten
8900  Overige baten
```

`4950` en `8150` zijn tegen elkaar te boeken zodat de reservefondsdotatie zichtbaar door de exploitatie loopt en op de balans in `0600` landt.

### 5.8 Datum, tijd en taal

- Tijdzone `Europe/Amsterdam`, opslag in UTC voor tijdstempels, `DATE` voor kalenderdata (boekdatum, vervaldatum, incassodatum) — geen tijdzoneconversie op kalenderdata.
- Weergave `d-m-Y`. Invoer accepteert `d-m-Y`, `d/m/Y` en `Y-m-d`.
- Boekjaar mag afwijken van het kalenderjaar (startmaand instelbaar).
- Werkdagen- en feestdagenkalender NL voor incassotermijnen.

---

---

## 6. Datamodel (PostgreSQL 16)

Conventies: tabel- en kolomnamen `snake_case` in het Nederlands. Primaire sleutels `bigint GENERATED ALWAYS AS IDENTITY`. Momenten in de tijd zijn `timestamptz` (opslag UTC); kalenderdata (boekdatum, vervaldatum, incassodatum) zijn `date` en ondergaan **nooit** tijdzoneconversie. Bedragen zijn `bigint` in centen. Alle tenant-tabellen dragen `vve_id` — ook waar dat via een join afleidbaar is — want dat is de kolom waarop Row-Level Security en de indexen aangrijpen.

Elke tabel heeft `aangemaakt_op timestamptz NOT NULL DEFAULT now()`; muteerbare tabellen ook `gewijzigd_op timestamptz` (gevuld door een trigger). Tabellen met historische waarde krijgen `verwijderd_op timestamptz` (soft delete) in plaats van harde verwijdering.

### 6.1 Extensies, enums en hulptypes

```sql
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitieve e-mailadressen
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy zoeken op naam/omschrijving

CREATE TYPE vve_status            AS ENUM ('actief','gearchiveerd');
CREATE TYPE modelreglement        AS ENUM ('MR1973','MR1983','MR1992','MR2006','MR2017','EIGEN');
CREATE TYPE rol_type              AS ENUM ('applicatiebeheerder','beheerder','voorzitter','penningmeester',
                                           'secretaris','bestuurslid','kascommissie','eigenaar','bewoner');
CREATE TYPE eenheid_type          AS ENUM ('woning','parkeerplaats','berging','bedrijfsruimte','gemeenschappelijk');
CREATE TYPE communicatie_wijze    AS ENUM ('email','post','beide');
CREATE TYPE bewoning_type         AS ENUM ('eigenaar_bewoner','huurder','gebruiker');
CREATE TYPE verdeelsleutel_type   AS ENUM ('breukdeel','vierkante_meters','gelijke_delen','stemmen','handmatig');
CREATE TYPE boekjaar_status       AS ENUM ('concept','open','afgesloten');
CREATE TYPE begroting_status      AS ENUM ('concept','voorgesteld_alv','vastgesteld','gesloten');
CREATE TYPE bijdrage_methode      AS ENUM ('uit_begroting','vast_bedrag','vierkante_meters');
CREATE TYPE periodiciteit         AS ENUM ('maand','kwartaal','jaar');
CREATE TYPE bijdrage_bron         AS ENUM ('berekend','handmatig');
CREATE TYPE nota_type             AS ENUM ('periodieke_bijdrage','afrekening','eenmalige_heffing',
                                           'boete','rente','incassokosten','credit');
CREATE TYPE nota_status           AS ENUM ('concept','open','deels_betaald','betaald','gecrediteerd','oninbaar');
CREATE TYPE betaalwijze           AS ENUM ('incasso','overboeking');
CREATE TYPE bankrekening_type     AS ENUM ('exploitatie','reserve','spaar','overig');
CREATE TYPE bank_formaat          AS ENUM ('camt053','mt940','csv');
CREATE TYPE transactie_status     AS ENUM ('nieuw','voorstel','geboekt','genegeerd');
CREATE TYPE betaling_bron         AS ENUM ('bank','kas','handmatig','incasso','verrekening');
CREATE TYPE machtiging_type       AS ENUM ('CORE','B2B');
CREATE TYPE machtiging_status     AS ENUM ('actief','geblokkeerd','ingetrokken','verlopen');
CREATE TYPE sequence_type         AS ENUM ('FRST','RCUR','OOFF','FNAL');
CREATE TYPE batch_status          AS ENUM ('concept','gegenereerd','ingediend','verwerkt','geannuleerd');
CREATE TYPE incassopost_status    AS ENUM ('open','geincasseerd','gestorneerd');
CREATE TYPE grootboek_categorie   AS ENUM ('activa','passiva','eigen_vermogen','lasten','baten');
CREATE TYPE boeking_bron          AS ENUM ('nota','betaling','bank','incasso','memoriaal','openingsbalans','jaarafsluiting');
CREATE TYPE afrekening_status     AS ENUM ('concept','voorgesteld_alv','vastgesteld','verwerkt');
CREATE TYPE mjop_status           AS ENUM ('concept','scenario','vastgesteld','vervallen');
CREATE TYPE activiteit_status     AS ENUM ('gepland','in_uitvoering','uitgevoerd','uitgesteld','vervallen');
CREATE TYPE verplichting_soort    AS ENUM ('liftkeuring','brandmeldinstallatie','legionella','nen3140',
                                           'opstalverzekering','aansprakelijkheid','bestuurdersaansprakelijkheid',
                                           'rechtsbijstand','energielabel','overig');
CREATE TYPE melding_prioriteit    AS ENUM ('laag','normaal','hoog','spoed');
CREATE TYPE melding_status        AS ENUM ('nieuw','in_behandeling','opdracht_verstrekt','afgerond','afgewezen');
CREATE TYPE zichtbaarheid         AS ENUM ('alle_leden','bewoners','bestuur','alleen_beheerder');
CREATE TYPE vergadering_type      AS ENUM ('alv','bijzondere_alv','bestuursvergadering');
CREATE TYPE vergadering_status    AS ENUM ('gepland','gehouden','geannuleerd');
CREATE TYPE agendapunt_soort      AS ENUM ('informatief','stemming');
CREATE TYPE vereiste_meerderheid  AS ENUM ('gewoon','twee_derde','drie_kwart','unaniem');
CREATE TYPE besluit_uitslag       AS ENUM ('aangenomen','verworpen','aangehouden');
CREATE TYPE stem_keuze            AS ENUM ('voor','tegen','onthouding');
CREATE TYPE mail_status           AS ENUM ('wachtend','bezig','verzonden','mislukt');
```

> **Migratienotitie:** waarden toevoegen aan een enum kan (`ALTER TYPE ... ADD VALUE`), verwijderen of hernoemen vereist een type-recreatie. Gebruik voor statussen die nog kunnen schuiven liever `text` met een `CHECK`-constraint. De bovenstaande lijst is stabiel genoeg voor enums.

### 6.2 Versleutelde betaalgegevens

IBAN's van bewoners zijn de gevoeligste gegevens in dit systeem. Ze worden **niet in leesbare vorm opgeslagen**. Overal waar een IBAN van een natuurlijk persoon voorkomt geldt hetzelfde drieluik:

| Kolom | Type | Doel |
|---|---|---|
| `<veld>_versleuteld` | `bytea` | AES-256-GCM, sleutel uit de omgeving (nooit in de database). Bevat nonce ‖ ciphertext ‖ tag. |
| `<veld>_hmac` | `bytea` | HMAC-SHA256 over het genormaliseerde IBAN met een aparte, vaste zoeksleutel. Deterministisch, dus indexeerbaar — hiermee koppelt de matchingmotor een bankmutatie aan een eigenaar zonder ooit te ontsleutelen. |
| `<veld>_masker` | `text` | `NL91 **** **** 1234`, voor weergave in lijsten. |
| `sleutel_versie` | `smallint` | Maakt sleutelrotatie mogelijk zonder downtime. |

Dit geldt voor `sepa_machtiging.iban` én voor `bank_transactie.tegenrekening_iban` — dat laatste is essentieel: incasso's en overboekingen van leden bevatten dezelfde IBAN's, en die half beschermen geeft alleen schijnzekerheid.

**Kosten die je hiermee accepteert, bewust:** je kunt niet meer ad hoc in de database zoeken op IBAN, een supportvraag vergt de applicatie, en sleutelrotatie is een expliciete achtergrondtaak. Dat is de prijs voor een databasedump die géén betaalgegevenslijst is. IBAN's van de VvE zelf en van leveranciers blijven leesbaar (`bankrekening.iban`, `leverancier.iban`): het zijn zakelijke rekeningnummers, en `bankrekening.iban` moet leesbaar blijven omdat wijziging daarvan de vier-ogen-procedure van §8.5 doorloopt.

De ruwe geïmporteerde bankbestanden in `/storage/import` bevatten dezelfde IBAN's in platte tekst. Sla die daarom versleuteld op met dezelfde sleutel, of bewaar ze niet langer dan de wettelijke controletermijn.

### 6.3 Kern en identiteit

```sql
CREATE TABLE vve (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  naam                 text        NOT NULL,
  kvk_nummer           text        UNIQUE,
  straat               text,
  huisnummer           text,
  postcode             text,
  plaats               text,
  splitsingsdatum      date,
  modelreglement       modelreglement,
  breukdeel_noemer     integer     NOT NULL DEFAULT 1000 CHECK (breukdeel_noemer > 0),
  boekjaar_startmaand  smallint    NOT NULL DEFAULT 1 CHECK (boekjaar_startmaand BETWEEN 1 AND 12),
  herbouwwaarde_cent   bigint      CHECK (herbouwwaarde_cent >= 0),
  iban_exploitatie     text,
  iban_reserve         text,
  incassant_id         text,                       -- SEPA Creditor Identifier
  logo_document_id     bigint,
  betaaltermijn_dagen  smallint    NOT NULL DEFAULT 14,
  status               vve_status  NOT NULL DEFAULT 'actief',
  aangemaakt_op        timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op         timestamptz
);

CREATE TABLE persoon (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                     citext      NOT NULL UNIQUE,
  wachtwoord_hash           text,                     -- argon2id
  voorletters               text,
  voornaam                  text,
  tussenvoegsel             text,
  achternaam                text        NOT NULL,
  telefoon                  text,
  corr_straat               text,
  corr_huisnummer           text,
  corr_postcode             text,
  corr_plaats               text,
  corr_land                 char(2)     NOT NULL DEFAULT 'NL',
  communicatie_wijze        communicatie_wijze NOT NULL DEFAULT 'email',
  is_applicatiebeheerder    boolean     NOT NULL DEFAULT false,
  wachtwoord_wijzigen_verplicht boolean NOT NULL DEFAULT false,
  wachtwoord_verloopt_op    timestamptz,
  mfa_verplicht             boolean     NOT NULL DEFAULT false,
  totp_secret_versleuteld   bytea,
  herstelcodes_hash         text[],                   -- argon2id per code, verbruikte worden verwijderd
  mislukte_pogingen         smallint    NOT NULL DEFAULT 0,
  geblokkeerd_tot           timestamptz,
  laatste_login_op          timestamptz,
  actief                    boolean     NOT NULL DEFAULT true,
  aangemaakt_op             timestamptz NOT NULL DEFAULT now(),
  gewijzigd_op              timestamptz
);

-- WebAuthn / passkeys: voorkeursmethode voor tweede factor
CREATE TABLE passkey (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persoon_id        bigint      NOT NULL REFERENCES persoon(id) ON DELETE CASCADE,
  credential_id     bytea       NOT NULL UNIQUE,
  publieke_sleutel  bytea       NOT NULL,
  teller            bigint      NOT NULL DEFAULT 0,
  apparaat_naam     text,
  laatst_gebruikt_op timestamptz,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rol_toewijzing (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint   NOT NULL REFERENCES vve(id),
  persoon_id    bigint   NOT NULL REFERENCES persoon(id),
  rol           rol_type NOT NULL,
  start_datum   date     NOT NULL,
  eind_datum    date,
  aangemaakt_op timestamptz NOT NULL DEFAULT now(),
  CHECK (eind_datum IS NULL OR eind_datum >= start_datum)
);
CREATE INDEX ix_rol_vve_persoon ON rol_toewijzing (vve_id, persoon_id);

-- Sessies van de mobiele app en de PWA: één rij per apparaat, roterende refresh tokens
CREATE TABLE apparaat_sessie (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persoon_id          bigint      NOT NULL REFERENCES persoon(id) ON DELETE CASCADE,
  familie_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  refresh_token_hash  char(64)    NOT NULL UNIQUE,     -- sha256 van het token
  vorige_token_hash   char(64),
  platform            text,                            -- 'web' | 'ios' | 'android'
  apparaat_naam       text,
  ip_laatste          inet,
  user_agent          text,
  verloopt_op         timestamptz NOT NULL,
  ingetrokken_op      timestamptz,
  intrekking_reden    text,
  laatst_gebruikt_op  timestamptz,
  aangemaakt_op       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessie_persoon ON apparaat_sessie (persoon_id) WHERE ingetrokken_op IS NULL;
CREATE INDEX ix_sessie_familie ON apparaat_sessie (familie_id);

CREATE TABLE uitnodiging (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id),
  wooneenheid_id   bigint,
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

CREATE TABLE wachtwoord_reset (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persoon_id    bigint      NOT NULL REFERENCES persoon(id) ON DELETE CASCADE,
  token_hash    char(64)    NOT NULL UNIQUE,
  verloopt_op   timestamptz NOT NULL,
  gebruikt_op   timestamptz,
  ip            inet,
  aangemaakt_op timestamptz NOT NULL DEFAULT now()
);
```

### 6.4 Eenheden en eigendom

```sql
CREATE TABLE gebouw (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id bigint NOT NULL REFERENCES vve(id),
  naam   text   NOT NULL,
  adres  text
);

CREATE TABLE wooneenheid (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id                bigint        NOT NULL REFERENCES vve(id),
  gebouw_id             bigint        REFERENCES gebouw(id),
  code                  text          NOT NULL,
  type                  eenheid_type  NOT NULL DEFAULT 'woning',
  straat                text,
  huisnummer            text,
  huisnummer_toevoeging text,
  postcode              text,
  plaats                text,
  bouwlaag              smallint,
  oppervlakte_m2        numeric(10,2) CHECK (oppervlakte_m2 >= 0),
  breukdeel_teller      integer       NOT NULL DEFAULT 1 CHECK (breukdeel_teller >= 0),
  breukdeel_noemer      integer       NOT NULL DEFAULT 1000 CHECK (breukdeel_noemer > 0),
  stemmen               integer       NOT NULL DEFAULT 1 CHECK (stemmen >= 0),
  kadastrale_aanduiding text,
  actief_vanaf          date,
  actief_tot            date,
  aangemaakt_op         timestamptz   NOT NULL DEFAULT now(),
  gewijzigd_op          timestamptz,
  UNIQUE (vve_id, code)
);

CREATE TABLE eigenaarschap (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint  NOT NULL REFERENCES vve(id),
  wooneenheid_id     bigint  NOT NULL REFERENCES wooneenheid(id),
  persoon_id         bigint  NOT NULL REFERENCES persoon(id),
  aandeel_promille   integer NOT NULL DEFAULT 1000 CHECK (aandeel_promille BETWEEN 0 AND 1000),
  is_primair_contact boolean NOT NULL DEFAULT false,
  periode            daterange NOT NULL,
  akte_datum         date,
  aangemaakt_op      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_eig_eenheid  ON eigenaarschap USING gist (wooneenheid_id, periode);
CREATE INDEX ix_eig_persoon  ON eigenaarschap (persoon_id);
```

> **`daterange` in plaats van twee datumkolommen.** PostgreSQL kan hiermee overlap uitsluiten wat MySQL niet kon. De eis "de gezamenlijke aandelen van een eenheid zijn op geen enkel moment > 100%" blijft domeinlogica (het is een som, geen simpele overlap), maar dubbele volledige eigendommen vang je wel af:
>
> ```sql
> ALTER TABLE eigenaarschap ADD CONSTRAINT geen_dubbel_volledig_eigendom
>   EXCLUDE USING gist (wooneenheid_id WITH =, periode WITH &&)
>   WHERE (aandeel_promille = 1000);
> ```
>
> Voor gedeelde eigendommen (partners, 500/500) valideert de domeinlaag de som per dag; dek dat af met test #34.

```sql
CREATE TABLE bewoning (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id         bigint        NOT NULL REFERENCES vve(id),
  wooneenheid_id bigint        NOT NULL REFERENCES wooneenheid(id),
  persoon_id     bigint        NOT NULL REFERENCES persoon(id),
  type           bewoning_type NOT NULL,
  periode        daterange     NOT NULL
);
```

### 6.5 Verdeelsleutels, begroting en bijdragen

```sql
CREATE TABLE verdeelsleutel (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id       bigint              NOT NULL REFERENCES vve(id),
  naam         text                NOT NULL,
  type         verdeelsleutel_type NOT NULL,
  versie       smallint            NOT NULL DEFAULT 1,
  actief       boolean             NOT NULL DEFAULT true,
  omschrijving text
);

CREATE TABLE verdeelsleutel_regel (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verdeelsleutel_id bigint        NOT NULL REFERENCES verdeelsleutel(id) ON DELETE CASCADE,
  wooneenheid_id    bigint        NOT NULL REFERENCES wooneenheid(id),
  gewicht           numeric(14,4) NOT NULL DEFAULT 0 CHECK (gewicht >= 0),
  UNIQUE (verdeelsleutel_id, wooneenheid_id)
);

CREATE TABLE boekjaar (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint          NOT NULL REFERENCES vve(id),
  jaar          smallint        NOT NULL,
  start_datum   date            NOT NULL,
  eind_datum    date            NOT NULL,
  status        boekjaar_status NOT NULL DEFAULT 'concept',
  afgesloten_op timestamptz,
  UNIQUE (vve_id, jaar),
  CHECK (eind_datum > start_datum)
);

CREATE TABLE begroting (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id         bigint           NOT NULL REFERENCES vve(id),
  boekjaar_id    bigint           NOT NULL UNIQUE REFERENCES boekjaar(id),
  status         begroting_status NOT NULL DEFAULT 'concept',
  vastgesteld_op date,
  besluit_id     bigint
);

CREATE TABLE begrotingsregel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  begroting_id         bigint  NOT NULL REFERENCES begroting(id) ON DELETE CASCADE,
  grootboekrekening_id bigint  NOT NULL,
  omschrijving         text    NOT NULL,
  bedrag_cent          bigint  NOT NULL,
  verdeelsleutel_id    bigint  NOT NULL REFERENCES verdeelsleutel(id),
  is_reservefonds      boolean NOT NULL DEFAULT false,
  volgorde             smallint NOT NULL DEFAULT 0
);

CREATE TABLE bijdrage_schema (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id        bigint           NOT NULL REFERENCES vve(id),
  boekjaar_id   bigint           NOT NULL REFERENCES boekjaar(id),
  methode       bijdrage_methode NOT NULL,
  periodiciteit periodiciteit    NOT NULL DEFAULT 'maand',
  ingangsdatum  date             NOT NULL,
  status        begroting_status NOT NULL DEFAULT 'concept',
  UNIQUE (boekjaar_id, ingangsdatum)
);

CREATE TABLE bijdrage_regel (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bijdrage_schema_id bigint        NOT NULL REFERENCES bijdrage_schema(id) ON DELETE CASCADE,
  wooneenheid_id     bigint        NOT NULL REFERENCES wooneenheid(id),
  exploitatie_cent   bigint        NOT NULL DEFAULT 0,
  reservefonds_cent  bigint        NOT NULL DEFAULT 0,
  bron               bijdrage_bron NOT NULL DEFAULT 'berekend',
  UNIQUE (bijdrage_schema_id, wooneenheid_id)
);
```

### 6.6 Nota's, betalingen, bank en incasso

```sql
CREATE TABLE nota (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint      NOT NULL REFERENCES vve(id),
  wooneenheid_id   bigint      NOT NULL REFERENCES wooneenheid(id),
  persoon_id       bigint      NOT NULL REFERENCES persoon(id),   -- debiteur bij uitgifte
  boekjaar_id      bigint      NOT NULL REFERENCES boekjaar(id),
  nummer           text        NOT NULL,
  type             nota_type   NOT NULL,
  periode_van      date,
  periode_tot      date,
  factuurdatum     date        NOT NULL,
  vervaldatum      date        NOT NULL,
  bedrag_cent      bigint      NOT NULL,
  openstaand_cent  bigint      NOT NULL,
  betaalwijze      betaalwijze NOT NULL DEFAULT 'overboeking',
  betalingskenmerk text        NOT NULL,
  status           nota_status NOT NULL DEFAULT 'concept',
  verzonden_op     timestamptz,
  pdf_document_id  bigint,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vve_id, nummer),
  UNIQUE (vve_id, betalingskenmerk),
  CHECK (openstaand_cent >= 0)
);
CREATE INDEX ix_nota_eenheid_status ON nota (wooneenheid_id, status);
CREATE INDEX ix_nota_openstaand     ON nota (vve_id, vervaldatum) WHERE status IN ('open','deels_betaald');

CREATE TABLE nota_regel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nota_id              bigint  NOT NULL REFERENCES nota(id) ON DELETE CASCADE,
  omschrijving         text    NOT NULL,
  bedrag_cent          bigint  NOT NULL,
  grootboekrekening_id bigint  NOT NULL,
  is_reservefonds      boolean NOT NULL DEFAULT false
);

CREATE TABLE bankrekening (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id               bigint            NOT NULL REFERENCES vve(id),
  iban                 text              NOT NULL,
  bic                  text,
  naam                 text              NOT NULL,
  type                 bankrekening_type NOT NULL,
  grootboekrekening_id bigint            NOT NULL,
  saldo_cent           bigint            NOT NULL DEFAULT 0,
  saldo_datum          date,
  UNIQUE (vve_id, iban)
);

CREATE TABLE bank_import (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint       NOT NULL REFERENCES vve(id),
  bankrekening_id   bigint       NOT NULL REFERENCES bankrekening(id),
  bestandsnaam      text         NOT NULL,
  formaat           bank_formaat NOT NULL,
  bestand_hash      char(64)     NOT NULL,
  aantal_regels     integer      NOT NULL,
  aantal_nieuw      integer      NOT NULL,
  beginsaldo_cent   bigint,
  eindsaldo_cent    bigint,
  geimporteerd_door bigint       NOT NULL REFERENCES persoon(id),
  geimporteerd_op   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (bankrekening_id, bestand_hash)
);

CREATE TABLE bank_transactie (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id                      bigint            NOT NULL REFERENCES vve(id),
  bankrekening_id             bigint            NOT NULL REFERENCES bankrekening(id),
  bank_import_id              bigint            NOT NULL REFERENCES bank_import(id),
  boekdatum                   date              NOT NULL,
  valutadatum                 date,
  bedrag_cent                 bigint            NOT NULL,       -- negatief = af
  tegenrekening_iban_versleuteld bytea,
  tegenrekening_iban_hmac     bytea,
  tegenrekening_iban_masker   text,
  sleutel_versie              smallint          NOT NULL DEFAULT 1,
  tegenrekening_naam          text,
  omschrijving                text,
  e2e_id                      text,
  transactiecode              text,
  regel_hash                  char(64)          NOT NULL,
  status                      transactie_status NOT NULL DEFAULT 'nieuw',
  boeking_id                  bigint,
  UNIQUE (bankrekening_id, regel_hash)
);
CREATE INDEX ix_transactie_status ON bank_transactie (vve_id, status, boekdatum);
CREATE INDEX ix_transactie_iban   ON bank_transactie (tegenrekening_iban_hmac);

CREATE TABLE betaling (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id             bigint        NOT NULL REFERENCES vve(id),
  datum              date          NOT NULL,
  bedrag_cent        bigint        NOT NULL,
  bron               betaling_bron NOT NULL,
  bank_transactie_id bigint        REFERENCES bank_transactie(id),
  wooneenheid_id     bigint        REFERENCES wooneenheid(id),
  omschrijving       text,
  aangemaakt_op      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_betaling_eenheid ON betaling (wooneenheid_id, datum);

CREATE TABLE betaling_koppeling (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  betaling_id bigint NOT NULL REFERENCES betaling(id) ON DELETE CASCADE,
  nota_id     bigint NOT NULL REFERENCES nota(id),
  bedrag_cent bigint NOT NULL CHECK (bedrag_cent <> 0),
  UNIQUE (betaling_id, nota_id)
);

CREATE TABLE sepa_machtiging (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id                bigint            NOT NULL REFERENCES vve(id),
  wooneenheid_id        bigint            NOT NULL REFERENCES wooneenheid(id),
  persoon_id            bigint            NOT NULL REFERENCES persoon(id),
  kenmerk               text              NOT NULL,
  iban_versleuteld      bytea             NOT NULL,
  iban_hmac             bytea             NOT NULL,
  iban_masker           text              NOT NULL,
  sleutel_versie        smallint          NOT NULL DEFAULT 1,
  bic                   text,
  tenaamstelling        text              NOT NULL,
  type                  machtiging_type   NOT NULL DEFAULT 'CORE',
  ondertekend_op        date              NOT NULL,
  ondertekend_ip        inet,
  machtigingstekst_hash char(64),
  eerste_incasso_gedaan boolean           NOT NULL DEFAULT false,
  vorig_kenmerk         text,                       -- AmdmntInf
  vorig_iban_masker     text,
  vorig_incassant_id    text,
  status                machtiging_status NOT NULL DEFAULT 'actief',
  storno_teller         smallint          NOT NULL DEFAULT 0,
  ingetrokken_op        date,
  UNIQUE (vve_id, kenmerk)
);
CREATE INDEX ix_machtiging_iban ON sepa_machtiging (iban_hmac);

CREATE TABLE incasso_batch (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id           bigint          NOT NULL REFERENCES vve(id),
  message_id       text            NOT NULL UNIQUE,
  incassodatum     date            NOT NULL,
  mandaattype      machtiging_type NOT NULL DEFAULT 'CORE',
  seq_type         sequence_type   NOT NULL DEFAULT 'RCUR',
  aantal_posten    integer         NOT NULL DEFAULT 0,
  totaal_cent      bigint          NOT NULL DEFAULT 0,
  status           batch_status    NOT NULL DEFAULT 'concept',
  bestand_pad      text,
  gegenereerd_op   timestamptz,
  gegenereerd_door bigint          REFERENCES persoon(id),
  goedgekeurd_door bigint          REFERENCES persoon(id),   -- vier-ogen, §8.5
  goedgekeurd_op   timestamptz
);

CREATE TABLE incasso_post (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incasso_batch_id bigint              NOT NULL REFERENCES incasso_batch(id) ON DELETE CASCADE,
  nota_id          bigint              NOT NULL REFERENCES nota(id),
  machtiging_id    bigint              NOT NULL REFERENCES sepa_machtiging(id),
  bedrag_cent      bigint              NOT NULL CHECK (bedrag_cent > 0),
  e2e_id           text                NOT NULL UNIQUE,
  status           incassopost_status  NOT NULL DEFAULT 'open',
  storno_code      text,
  storno_reden     text,
  storno_datum     date
);

CREATE TABLE aanmaning (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id       bigint   NOT NULL REFERENCES vve(id),
  nota_id      bigint   NOT NULL REFERENCES nota(id),
  stap         smallint NOT NULL CHECK (stap BETWEEN 1 AND 3),
  verzonden_op timestamptz,
  kosten_cent  bigint   NOT NULL DEFAULT 0,
  rente_cent   bigint   NOT NULL DEFAULT 0,
  document_id  bigint
);
```

### 6.7 Grootboek en jaarafsluiting

```sql
CREATE TABLE grootboekrekening (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id            bigint              NOT NULL REFERENCES vve(id),
  nummer            text                NOT NULL,
  naam              text                NOT NULL,
  categorie         grootboek_categorie NOT NULL,
  is_reservefonds   boolean             NOT NULL DEFAULT false,
  verdeelsleutel_id bigint              REFERENCES verdeelsleutel(id),
  actief            boolean             NOT NULL DEFAULT true,
  UNIQUE (vve_id, nummer)
);

CREATE TABLE boeking (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id          bigint       NOT NULL REFERENCES vve(id),
  boekjaar_id     bigint       NOT NULL REFERENCES boekjaar(id),
  nummer          text         NOT NULL,
  datum           date         NOT NULL,
  omschrijving    text         NOT NULL,
  bron            boeking_bron NOT NULL,
  bron_id         bigint,
  vergrendeld     boolean      NOT NULL DEFAULT false,
  aangemaakt_door bigint       NOT NULL REFERENCES persoon(id),
  aangemaakt_op   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (vve_id, nummer)
);
CREATE INDEX ix_boeking_datum ON boeking (vve_id, datum);

CREATE TABLE boekingsregel (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  boeking_id           bigint NOT NULL REFERENCES boeking(id) ON DELETE RESTRICT,
  grootboekrekening_id bigint NOT NULL REFERENCES grootboekrekening(id),
  wooneenheid_id       bigint REFERENCES wooneenheid(id),
  omschrijving         text,
  debet_cent           bigint NOT NULL DEFAULT 0 CHECK (debet_cent  >= 0),
  credit_cent          bigint NOT NULL DEFAULT 0 CHECK (credit_cent >= 0),
  CHECK ((debet_cent = 0) <> (credit_cent = 0))     -- precies één van beide gevuld
);
CREATE INDEX ix_regel_grootboek ON boekingsregel (grootboekrekening_id, boeking_id);
CREATE INDEX ix_regel_eenheid   ON boekingsregel (wooneenheid_id);
```

De balanseis is per boeking af te dwingen met een **`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`** die aan het eind van de transactie controleert dat `SUM(debet_cent) = SUM(credit_cent)` per `boeking_id`. Dit is het laatste vangnet onder de boekingsservice uit §7.4; beide moeten bestaan.

```sql
CREATE TABLE afrekening (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vve_id         bigint            NOT NULL REFERENCES vve(id),
  boekjaar_id    bigint            NOT NULL UNIQUE REFERENCES boekjaar(id),
  status         afrekening_status NOT NULL DEFAULT 'concept',
  gegenereerd_op timestamptz,
  besluit_id     bigint
);

CREATE TABLE afrekening_regel (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  afrekening_id  bigint    NOT NULL REFERENCES afrekening(id) ON DELETE CASCADE,
  wooneenheid_id bigint    NOT NULL REFERENCES wooneenheid(id),
  persoon_id     bigint    NOT NULL REFERENCES persoon(id),
  periode        daterange NOT NULL,
  werkelijk_cent bigint    NOT NULL,
  voorschot_cent bigint    NOT NULL,
  saldo_cent     bigint    NOT NULL,           -- positief = te vorderen
  nota_id        bigint    REFERENCES nota(id)
);
```

### 6.8 MJOP, onderhoud, documenten, vergaderingen, systeem

De tabellen `mjop`, `mjop_element`, `mjop_activiteit`, `leverancier`, `contract`, `verplichting`, `melding`, `melding_reactie`, `document`, `document_koppeling`, `vergadering`, `agendapunt`, `aanwezigheid`, `besluit`, `stem`, `mededeling`, `mail_wachtrij`, `audit_log` en `instelling` volgen één op één de opzet van versie 1.0 van dit document, met deze omzettingen: identiteitskolommen als `bigint GENERATED ALWAYS AS IDENTITY`, enums uit §6.1, `timestamptz` voor momenten, `jsonb` voor JSON-kolommen, `inet` voor IP-adressen, en `daterange` waar een start- en einddatum samen een periode vormden.

Twee wijzigingen ten opzichte van 1.0:

**Volledig-tekstzoeken** op documenten gaat via een gegenereerde kolom in plaats van een MySQL-FULLTEXT-index:

```sql
ALTER TABLE document ADD COLUMN zoekvector tsvector
  GENERATED ALWAYS AS (to_tsvector('dutch', coalesce(titel,'') || ' ' || coalesce(tags,''))) STORED;
CREATE INDEX ix_document_zoek ON document USING gin (zoekvector);
```

**Het auditlog wordt manipulatiebestendig** met een hashketen — belangrijk omdat de beheerder van de applicatie tevens de beheerder van de server is en er dus geen scheiding der machten is:

```sql
ALTER TABLE audit_log
  ADD COLUMN vorige_hash char(64),
  ADD COLUMN eigen_hash  char(64) NOT NULL;
-- eigen_hash = sha256(vorige_hash ‖ canonieke JSON van deze regel)
```

Een dagelijkse taak verifieert de keten en publiceert het laatste hoofdhash naar een externe locatie (bijvoorbeeld een dagelijkse e-mail aan het bestuur). Wie achteraf een regel wijzigt of verwijdert, breekt de keten aantoonbaar. De applicatierol krijgt uitsluitend `INSERT` op `audit_log`, geen `UPDATE` of `DELETE`.

### 6.9 Row-Level Security — de tweede slotgracht

Dit is de belangrijkste winst van PostgreSQL voor deze applicatie. De API scoopt al op `vve_id`; RLS zorgt dat een vergeten filter een **lege resultset** oplevert in plaats van de gegevens van een andere VvE.

**Drie databaserollen:**

| Rol | Gebruik | RLS |
|---|---|---|
| `vve_migratie` | Eigenaar van het schema, alleen voor migraties | n.v.t. (draait buiten requestverwerking) |
| `vve_app` | Alle normale requestverwerking | Onderworpen aan RLS, geen `BYPASSRLS` |
| `vve_platform` | Uitsluitend de expliciet gemarkeerde beheerendpoints (VvE aanmaken, systeemoverzicht) | `BYPASSRLS`, elke query gelogd |

**Per tenant-tabel:**

```sql
ALTER TABLE nota ENABLE ROW LEVEL SECURITY;
ALTER TABLE nota FORCE  ROW LEVEL SECURITY;     -- ook de eigenaar is gebonden

CREATE POLICY tenant_isolatie ON nota
  USING      (vve_id = current_setting('app.vve_id')::bigint)
  WITH CHECK (vve_id = current_setting('app.vve_id')::bigint);
```

De API zet dit per transactie:

```sql
SET LOCAL app.vve_id = $1;   -- uit het geverifieerde token, NOOIT uit de request
```

`current_setting('app.vve_id')` zonder de tweede parameter **werpt een fout** als de variabele niet gezet is. Dat is opzet: een query buiten een tenant-context faalt hard in plaats van stil alle rijen te tonen. Fail closed.

Aandachtspunten die je moet dichtzetten:
- **Connection pooling.** Met PgBouncer in `transaction`-modus is `SET LOCAL` binnen een transactie correct; in `session`-modus lekt een instelling naar de volgende gebruiker. Gebruik transactiemodus, en zet de tenant altijd binnen dezelfde transactie als de query.
- **`vve_platform` is geen gemakszekering.** Elk endpoint dat deze rol gebruikt staat op een expliciete, korte allowlist en logt wie wat opvroeg.
- **Testen, niet aannemen.** Test #27 (§11) draait met de `vve_app`-rol en een verkeerde `app.vve_id` over alle endpoints; test #33 controleert dat RLS zelfstandig blokkeert, met de applicatiescoping bewust uitgeschakeld.

### 6.10 Integriteit en concurrency

- Foreign keys overal, `ON DELETE RESTRICT` op alles wat financieel is. Financiële data wordt nooit gecascadeerd verwijderd.
- Elke financiële schrijfactie draait in één transactie. Bij afletteren `SELECT ... FROM nota WHERE id = $1 FOR UPDATE` om dubbele afboeking bij gelijktijdige import te voorkomen.
- Nota- en boekingsnummering per VvE per boekjaar via een aparte `nummerreeks`-tabel met `SELECT ... FOR UPDATE`, niet via `MAX(nummer)+1` en niet via een globale sequence — anders krijg je gaten of duplicaten bij gelijktijdige generatie (test #10).

---

## 7. Technische architectuur

### 7.1 Stack

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Taal | **TypeScript 5.x**, `strict: true` overal | Eén taal voor API, domeinlogica en client; gedeelde types elimineren contractfouten tussen backend en app. |
| API | **NestJS 11** | Gestructureerd genoeg om niet te improviseren op autorisatie: modules, guards, interceptors, DI. |
| Database | **PostgreSQL 16** | Row-Level Security (§6.9), `daterange` met exclusion constraints, deferred constraint triggers, degelijke transacties. |
| Datatoegang | **Drizzle ORM** | Transparante SQL en volledige controle over transacties — noodzakelijk om `SET LOCAL app.vve_id` betrouwbaar per transactie te zetten. *Prisma mag ook, maar de RLS-koppeling is daar omslachtiger.* |
| Validatie & contract | **Zod** + `nestjs-zod` | Eén schema is tegelijk runtime-validatie op de API én het TypeScript-type in de Ionic-client. |
| Jobs | **pg-boss** | Wachtrij ín PostgreSQL. Geen Redis erbij op een server die jij alleen beheert; jobs zijn transactioneel met je data. |
| Client | **Ionic 8 + Angular** + **Capacitor** | Angular deelt zijn modules-, decorator- en DI-model met NestJS: één mentaal model over de hele stack. *Ionic + React is een prima alternatief als je Angular niet ligt.* |
| Auth | `argon2`, `jose` (JWT), `@simplewebauthn/server` (passkeys), `otplib` (TOTP als terugvaloptie) | Zie §7.6. |
| Mail | `nodemailer` + wachtrij in de database | Een falende SMTP mag nooit een gebruikersactie laten mislukken. |
| PDF | `pdfmake` | Deterministisch, geen Chromium op de server. Puppeteer alleen als de opmaak het echt vereist. |
| Spreadsheet | `exceljs` | Import/export XLSX. |
| XML | `fast-xml-parser` (CAMT/pain.002) + `xmlbuilder2` (pain.008) | Zie de waarschuwing hieronder. |
| IBAN | `ibantools` | Validatie mod-97 en per-land-lengte. |
| Tests | **Vitest** + **Testcontainers** (echte PostgreSQL) | RLS- en concurrency-tests zijn zinloos tegen een in-memory nepdatabase. |
| Kwaliteit | ESLint (`@typescript-eslint`, `strict-type-checked`), Prettier | Blokkerend in CI. |

> **Eén eerlijk zwak punt van deze stack.** De Node-bibliotheken voor CAMT.053, MT940 en pain.008 zijn dunner en minder onderhouden dan hun PHP-tegenhangers. Behandel die parsers en generatoren daarom als **eigen domeincode**, niet als een afhankelijkheid: schrijf ze zelf in `packages/domein/bank` en `packages/domein/sepa`, en test ze tegen echte, geanonimiseerde bestanden van je eigen bank. XSD-validatie van het gegenereerde pain.008 doe je met `xmllint --schema` vanuit de container — betrouwbaarder dan de native Node-XSD-bindings, die notoir slecht bouwen.

### 7.2 Repositoryindeling (npm workspaces monorepo)

```
/apps
  /api                      NestJS
    /src
      /modules              per domein: vve, eenheden, financieel, bank, sepa, mjop, alv, documenten
        /<module>
          <module>.controller.ts    alleen HTTP: valideren, autoriseren, delegeren
          <module>.service.ts       use case, transactiegrens
          <module>.repository.ts    Drizzle-queries
          dto/                      Zod-schema's (her-geëxporteerd uit packages/contract)
      /gemeenschappelijk
        /auth                 guards, token-uitgifte, sessies, MFA
        /tenant               TenantContext, SET LOCAL, RLS-transactiehelper
        /audit                auditlog-interceptor met hashketen
        /observability        logging, metrics, traces
      /database
        /schema               Drizzle-schema
        /migraties            SQL-migraties, genummerd, alleen voorwaarts
        /seeds
  /app                      Ionic + Angular (PWA en, via Capacitor, iOS/Android)
    /src/app
      /kern                 auth, http-interceptor, tokenopslag, foutafhandeling
      /portaal              eigenaarschermen
      /beheer               beheerschermen (alleen web, zie §7.8)
/packages
  /domein                   PURE TypeScript: geen NestJS, geen Drizzle, geen I/O
    /financieel             Bedrag, Verdeler, Bijdrageberekening, Aflettering, Rente
    /vve                    Breukdeel, Eigenaarschap, Stemgewicht
    /bank                   Camt053Parser, Mt940Parser, CsvParser, Matcher
    /sepa                   MandaatKenmerk, PainGenerator, StornoVerwerker
    /mjop                   Indexatie, Prognose, BenodigdeDotatie
  /contract                 Zod-schema's + afgeleide types, gedeeld door API en client
/infra
  docker-compose.yml, Caddyfile, backupscripts, migratierunner
/docs
  besluiten.md, handleiding-beheerder.md, handleiding-eigenaar.md, avg/
```

**Harde regel:** `packages/domein` importeert niets uit `apps/api`, geen NestJS, geen databaseclient, geen `Date.now()`, geen `fetch`. Alle berekeningen zijn daardoor unit-testbaar zonder database of HTTP. Handhaaf dit met een ESLint-`no-restricted-imports`-regel plus een architectuurtest die de importgrafiek controleert — niet met goede voornemens.

### 7.3 Kernabstracties

```ts
/** Geld. Uitsluitend hele centen. Er is geen constructor die een float accepteert. */
export class Bedrag {
  private constructor(readonly centen: number) {
    if (!Number.isSafeInteger(centen)) throw new BedragFout(`Geen geheel aantal centen: ${centen}`);
  }
  static vanCenten(c: number): Bedrag;
  static vanInvoer(s: string): Bedrag;      // "1.234,56" en "1234.56"
  static nul(): Bedrag;
  plus(b: Bedrag): Bedrag;
  min(b: Bedrag): Bedrag;
  maal(factor: number): Bedrag;             // factor moet geheel zijn
  isNegatief(): boolean;
  formatteer(): string;                     // "€ 1.234,56"
}

export interface Verdeler {
  /** Grootste-restmethode (§5.2).
   *  Garantie: som(resultaat.values()) === totaal.centen — afgedwongen met een assertie. */
  verdeel(totaal: Bedrag, gewichten: Map<EenheidId, number>): Map<EenheidId, Bedrag>;
}

export interface Klok {
  nu(): Date;              // moment, UTC
  vandaag(): KalenderDag;  // Europe/Amsterdam
}
```

`Klok` wordt overal geïnjecteerd; `new Date()` en `Date.now()` staan op de ESLint-verbodslijst buiten de infrastructuurlaag. Zonder dat zijn vervaldatum-, aanmanings- en SEPA-termijntests niet betrouwbaar te schrijven.

Een ESLint-regel verbiedt daarnaast rekenkundige operatoren op velden waarvan de naam op `_cent` of `Cent` eindigt. In TypeScript kun je `a + b` op `number` niet blokkeren met het typesysteem alleen; deze regel is wat `Bedrag` afdwingbaar maakt in plaats van een suggestie.

### 7.4 De boekingsservice

Het enige pad naar `boeking` en `boekingsregel`:

```ts
await this.boekhouding.boek(tx, {
  vve, datum, omschrijving: 'Bijdrage februari 2026', bron: 'nota', bronId: nota.id,
  regels: [
    Regel.debet('1300', totaal, { eenheid }),
    Regel.credit('8100', exploitatie),
    Regel.credit('8150', reserve),
  ],
});
// gooit OnbalansFout als debet !== credit; de deferred constraint trigger (§6.7) vangt af
// wat er buiten deze service om toch geprobeerd wordt.
```

Boekingen zijn **append-only**. Een fout wordt gecorrigeerd met een tegenboeking, nooit met een `UPDATE`. De applicatierol heeft daarom geen `UPDATE`- of `DELETE`-recht op `boeking` en `boekingsregel`; alleen `vergrendeld` mag door de jaarafsluiting worden gezet, via een aparte, expliciet gerechtigde routine.

### 7.5 API-ontwerp en autorisatie

Omdat er geen server-rendered laag meer is, is dit het hart van de beveiliging.

**Elke request doorloopt in deze volgorde:**

1. **`AuthGuard`** — verifieert het access token (signature, `exp`, `aud`, `iss`) en laadt de persoon. Geen token → 401.
2. **`TenantGuard`** — bepaalt de actieve VvE **uit het token**, controleert dat de persoon daar een actieve `rol_toewijzing` heeft, en zet `TenantContext`. Een `vve_id` in body, query of pad wordt alleen geaccepteerd als het gelijk is aan de context; anders 403. Er is geen route waarop de client de tenant kiest.
3. **`RolGuard`** — `@VereistRecht('nota.genereren')`. **Een endpoint zonder rechtdeclaratie wordt geweigerd**, niet toegelaten: een opstarttest inventariseert alle routes en faalt als er één zonder decorator is.
4. **`ZodValidationPipe`** — schema per endpoint, onbekende velden worden geweigerd (`.strict()`). Dit is tevens de bescherming tegen mass assignment: er bestaat geen pad waarlangs een veld de service in komt dat niet in het schema staat.
5. **Service** — opent de transactie, zet `SET LOCAL app.vve_id`, voert de use case uit.
6. **Objectcontrole in de service** — een eigenaar die `GET /notas/1234` opvraagt van een andere eenheid krijgt **404, niet 403**: bestaan is zelf al informatie.
7. **`AuditInterceptor`** — schrijft muterende acties weg in de hashketen (§6.8).

**Verdere API-regels:**
- Rate limiting op de hele API, niet alleen op de login: per IP en per account, met strengere limieten op `/auth/*`, exports en documentdownloads.
- Paginering verplicht op elke lijst; geen onbegrensde `findAll`.
- CORS strikt op een allowlist. Vergeet niet dat Capacitor vanaf `capacitor://localhost` (iOS) en `http://localhost` (Android) praat; noem die expliciet, nooit een wildcard.
- Uniforme foutrespons `{ code, melding, referentie }`. In productie nooit stacktraces; de `referentie` is terug te vinden in het log.
- Alle bestandsdownloads via een endpoint dat rol, tenant en `zichtbaarheid` controleert en de stream teruggeeft. Geen publieke of te raden URL's; gebruik desgewenst kortlevende, ondertekende links (maximaal 5 minuten, gebonden aan de persoon).
- Idempotentiesleutel op `POST` van nota-generatie en incassobatches, zodat een herhaalde verzending door een haperende mobiele verbinding geen dubbele batch oplevert.

### 7.6 Authenticatie en tokens

**Correctie op mijn eerdere advies:** bouw hier géén OAuth2/OIDC-server met PKCE. Dat is bedoeld voor het delegeren van toegang aan derde partijen. Jouw app is first-party met een eigen inlogscherm; een half-geïmplementeerde OIDC-server is dan meer aanvalsoppervlak, niet minder. Doe dit in plaats daarvan:

| | Web (PWA in de browser) | Native app (Capacitor) |
|---|---|---|
| Access token | JWT, 15 minuten, in geheugen | JWT, 15 minuten, in geheugen |
| Refresh token | **httpOnly + Secure + SameSite=Strict cookie**, pad `/auth/refresh` | Opaak token in **Keychain / Android Keystore** via Capacitor Secure Storage |
| CSRF | Nodig omdat de refresh via een cookie loopt: dubbele-submit-token op `/auth/refresh` | Niet van toepassing (geen cookies) |
| Opslag | Nooit `localStorage` of `sessionStorage` | Nooit `Preferences`, nooit `localStorage` |

**Refresh-rotatie met hergebruikdetectie.** Elk refresh-verzoek geeft een nieuw token terug en ongeldigt het vorige (`apparaat_sessie`, §6.3). Wordt een reeds gebruikt token nog eens aangeboden, dan is het gestolen: trek de **hele `familie_id`** in, log de gebruiker op dat apparaat uit en stuur een e-mail. Dit is de enige praktische verdediging tegen een gestolen refresh token op een telefoon.

**Verder:**
- Wachtwoorden: `argon2id`, minimaal 12 tekens, getoetst tegen een lijst met veelgebruikte wachtwoorden (`zxcvbn` of een lokale HIBP-lijst). Geen verplichte complexiteitsregels, geen periodieke wisseldwang.
- **MFA verplicht op basis van rechten, niet van rollen.** Wie een recht uit de geldstroomlijst (§8.5) krijgt toegekend, moet een tweede factor hebben; toekennen aan iemand zonder MFA wordt geweigerd. Zo kan een later toegevoegde rol nooit per ongeluk zonder MFA bij het geld.
- **Passkeys (WebAuthn) zijn de primaire inlogmethode**, niet alleen een tweede factor: voor vrijwilligers is Face ID of Touch ID eenvoudiger dan een wachtwoord plus authenticator-app, en het haalt het grootste deel van het wachtwoordherstelverkeer weg. Wachtwoord blijft als terugval, TOTP als tweede terugval, herstelcodes eenmalig getoond en als argon2-hash opgeslagen.
- **WebAuthn werkt niet vanzelf in een Capacitor-webview**; daarvoor is een native plugin nodig die de platform-API aanspreekt. Reken daar een apart werkblok voor in fase 7; tot die tijd verloopt passkey-registratie via de PWA.
- **Herauthenticatie** (opnieuw MFA, ongeacht een lopende sessie) voor: incassobatch genereren, IBAN of incassant-ID wijzigen, mandaat muteren, boekjaar afsluiten, gebruikersrol wijzigen.
- Rate limiting op inloggen: 5 pogingen per account per 15 minuten, 20 per IP, oplopende vertraging, altijd dezelfde foutmelding ("e-mailadres of wachtwoord onjuist").
- Uitloggen trekt de sessie in; "log alle apparaten uit" trekt alle `apparaat_sessie`-rijen van de persoon in. De apparatenlijst is zichtbaar in het profiel met platform, laatste gebruik en IP.
- Impersonatie door de applicatiebeheerder: alleen met opgegeven reden, zichtbaar in de UI, gelogd, en met een e-mailmelding aan de geïmpersoneerde persoon.

### 7.7 Achtergrondtaken (pg-boss)

| Taak | Frequentie | Actie |
|---|---|---|
| `mail:verwerk` | 1 min | Verstuur uit de wachtrij, exponentiële backoff, maximaal 5 pogingen. |
| `nota:genereer` | dagelijks | Periodieke nota's voor de nieuwe periode, alleen bij een vastgesteld bijdrageschema. |
| `debiteuren:signaleer` | dagelijks | Zet aanmaningsstappen klaar; verzenden gebeurt altijd na bevestiging door een mens. |
| `signalering:verplichtingen` | dagelijks | Verlopende polissen, keuringen en contracten (T-90/T-60/T-14). |
| `incasso:herinner` | dagelijks | Waarschuw als de aanlevertermijn van de volgende incassoronde nadert. |
| `audit:verifieer_keten` | dagelijks | Controleer de hashketen, mail het hoofdhash naar het bestuur. |
| `sleutel:roteer` | op verzoek | Herversleutel IBAN-kolommen naar een nieuwe sleutelversie, in batches. |
| `backup:controle` | dagelijks | Verifieer dat de laatste backup geslaagd, offsite en herstelbaar is. |
| `opschonen` | wekelijks | Verlopen tokens, ingetrokken sessies, tijdelijke bestanden, bewaartermijnen. |

Alle taken zijn idempotent en draaien onder een lock, zodat een overlappende run niets dubbel doet.

### 7.8 De Ionic-client

**PWA eerst, native later.** Bouw en release als installeerbare PWA; zet Capacitor er pas overheen wanneer push-notificaties of app-store-aanwezigheid daadwerkelijk nodig zijn. Zelfde codebase, en je releases worden niet geblokkeerd door een reviewcyclus.

**De app kan bewust minder dan de webomgeving.** Dit is een beveiligingsmaatregel, geen tekortkoming:

| Wel in de app | Alleen op web, achter MFA-herauthenticatie |
|---|---|
| Eigen nota's, betaalhistorie, jaaropgave | Incassobatch genereren of goedkeuren |
| Documenten en ALV-stukken lezen | IBAN of incassant-ID van de VvE wijzigen |
| Meldingen indienen met foto's | Mandaten muteren |
| Stemmen en volmacht verlenen | Boekjaar afsluiten |
| Mededelingen lezen | Gebruikers- en rollenbeheer |
| Eigen gegevens en machtiging beheren | Bankbestanden importeren |

De server dwingt dit af aan de hand van een `client`-claim in het token — niet de client zelf. Een gestolen telefoon met een geldige sessie kan daardoor geen geld verplaatsen.

**Verder:**
- Geen gevoelige gegevens offline cachen. Documenten worden gestreamd, niet permanent op het toestel gezet; de app wist zijn cache bij uitloggen.
- Geen sleutels of geheimen in de bundle. Alles in de app is openbaar, inclusief de omgevingsvariabelen van de build.
- Schermafscherming en achtergrond-blur op iOS/Android bij het tonen van financiële schermen (`Privacy Screen`-plugin).
- Biometrische ontgrendeling van het lokaal opgeslagen refresh token, niet als vervanging van de inlog maar als extra slot.
- Toegankelijkheid: WCAG 2.1 AA; Ionic-componenten geven veel gratis, maar controleer contrast en labels alsnog.

### 7.9 Draaien en beheren

Eén VPS die jij beheert, alles in Docker Compose achter **Caddy** (automatische TLS, HSTS).

- Postgres in een eigen container, **niet aan het internet blootgesteld**; alleen bereikbaar op het interne netwerk.
- Geen SSH-wachtwoorden, alleen sleutels; firewall dicht op 22/80/443; automatische security-updates; `fail2ban`.
- Secrets uit environmentbestanden buiten de repository, met bestandsrechten `600`. De versleutelingssleutels voor IBAN-kolommen staan **niet** in dezelfde backup als de database — anders is de versleuteling zinloos.
- Backups: `pg_dump` plus WAL-archivering, versleuteld met `restic` naar offsite object storage met **object lock** (append-only), zodat ransomware ze niet kan wissen. Bewaarschema 7/4/12. **Kwartaalijks een echte restore uitvoeren en het resultaat noteren in `docs/besluiten.md`** — een backup die je nooit hebt teruggezet is een aanname.
- Logging gescheiden in kanalen `app`, `financieel` en `beveiliging`; het beveiligingskanaal gaat ook naar een tweede bestemming buiten de server.
- Health-endpoints en een externe uptime-controle. Alarm bij: mislukte backup, gebroken auditketen, ongebruikelijk aantal mislukte logins, exportvolume boven de drempel.
- Migraties draaien onder `vve_migratie`, apart van de applicatie, alleen voorwaarts, en met een gecontroleerd terugrolpad per migratie.

---

## 8. Beveiliging en AVG

### 8.1 Dreigingsbeeld

Bouw tegen de dreigingen die er voor déze applicatie werkelijk toe doen, in deze volgorde:

1. **Overname van een beheerdersaccount, gevolgd door een stille IBAN-wijziging.** De maandelijkse incasso wordt omgeleid en niemand merkt het tot de VvE geen geld ontvangt. Dit is realistischer dan welke code-exploit dan ook. Verdediging: §8.5.
2. **Lek over VvE-grenzen heen.** Eén vergeten filter in één endpoint stelt de gegevens van alle VvE's bloot. Verdediging: autorisatie op de API (§7.5) plus RLS (§6.9) plus test #27 en #33.
3. **Databasediefstal.** Een dump zonder sleutels bevat geen IBAN's (§6.2) en geen bruikbare wachtwoorden (argon2id).
4. **Verlies of gijzeling van de administratie.** Zeven jaar financiële historie is niet te reconstrueren. Verdediging: §8.6.
5. **Kwaadaardige of gekaapte npm-afhankelijkheid.** In het Node-ecosysteem een reëel risico. Verdediging: §8.2.
6. **Insider.** De beheerder is meestal zelf eigenaar en heeft belang bij de cijfers. Verdediging: append-only grootboek, manipulatiebestendig auditlog (§6.8) en de kascommissie-modus (M9).

### 8.2 Applicatiebeveiliging

- **SQL:** uitsluitend geparametriseerde queries via Drizzle. Dynamische identifiers (sorteervelden, kolomnamen) alleen via een allowlist, nooit uit gebruikersinvoer.
- **Injectie in de client:** Angular escapet standaard; `bypassSecurityTrust*` staat op de ESLint-verbodslijst. Door gebruikers ingevoerde HTML (mededelingen) wordt server-side gesaneerd met `sanitize-html` en met een strikte allowlist opgeslagen — nooit pas bij weergave.
- **Uploads:** allowlist op extensie én op het door `file-type` bepaalde werkelijke MIME-type, maximum 25 MB, hernoemen naar UUID, opslag buiten elke webroot. Geen uitvoerbare inhoud, ook niet in een PDF-jasje. Optioneel ClamAV in een sidecar-container.
- **Headers** via Helmet: strikte `Content-Security-Policy` zonder `unsafe-inline` (nonces), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy`.
- **Toeleveringsketen** — het punt waarop deze stack meer aandacht vraagt dan PHP:
  - `package-lock.json` vastgelegd; installaties in CI en productie met `npm ci`, nooit `npm install`.
  - Renovate of Dependabot voor updates, maar met een **wachttijd van 3 dagen** op nieuwe versies — de meeste gekaapte pakketten worden binnen een dag ontdekt.
  - `npm audit` en een SCA-scan blokkerend in CI; `npm config set ignore-scripts true` waar mogelijk, want installatiescripts zijn de gebruikelijke aanvalsroute.
  - Houd de afhankelijkhedenlijst kort. Elk pakket dat je zelf in vijftig regels kunt schrijven, schrijf je zelf — dat geldt zeker voor de bank- en SEPA-parsers (§7.1).
  - Bouw de productie-image met een lockfile en een vastgezette base image (digest, geen `:latest`).
- **Foutafhandeling:** in productie geen stacktraces naar de client; wel een foutreferentie die in het log staat.
- **Geen geheimen in de repository.** `.env.voorbeeld` wel; een secret-scanner in CI.

### 8.3 AVG — je bent verwerker

Omdat je één omgeving draait voor meerdere VvE's, ben je **verwerker** voor elke VvE afzonderlijk. Dat is geen formaliteit; regel het vóór de tweede VvE aansluit.

- **Verwerkersovereenkomst per VvE**, als sjabloon in `docs/avg/`. De VvE is verwerkingsverantwoordelijke, jij verwerker.
- **Verwerkingsregister** dat de applicatie zelf kan genereren: welke categorieën persoonsgegevens, met welk doel, welke bewaartermijn, wie toegang heeft.
- **Datalekprocedure** uitgeschreven, met de meldplicht binnen 72 uur en een vooraf opgestelde conceptmelding. Oefen dit één keer.
- **Dataminimalisatie:** geen BSN, geen geboortedatum, geen identiteitsbewijzen. Die velden bestaan niet en de import weigert kolommen die erop lijken.
- **Bewaartermijnen** (instelbaar, met deze defaults): financiële administratie 7 jaar, mandaatbewijs tot 14 maanden na de laatste incasso, notulen en besluiten onbeperkt, meldingen 5 jaar, auditlog 3 jaar, mailwachtrij 2 jaar, ingetrokken sessies 90 dagen. Een taak signaleert overschrijding; verwijderen na bevestiging.
- **Rechten van betrokkenen:** export per persoon (JSON + PDF) en een verwijderprocedure die persoonsgegevens pseudonimiseert ("Voormalig eigenaar #123") maar de financiële historie intact laat — die moet bewaard blijven.
- **Toegangslogging:** inzage in het debiteurendossier van een ander lid wordt gelogd.
- **Subverwerkers** (hostingpartij, object storage, mailrelay) benoemd in de verwerkersovereenkomst, allemaal binnen de EU.

### 8.4 Zichtbaarheid tussen leden

Eigenaren zien **nooit** de betaalachterstand, het IBAN of de contactgegevens van een ander lid. Een ledenlijst is optioneel per VvE en toont dan alleen naam en eenheid, met opt-out per persoon. Achterstanden in ALV-stukken zijn standaard geanonimiseerd per eenheidscode, niet op naam, tenzij de ALV anders besluit — en dat besluit wordt vastgelegd.

### 8.5 Vier-ogen en fraudebestendigheid op de geldstroom

De maatregelen die de belangrijkste dreiging afdekken:

- **Geen uitgaande betaalbestanden.** De applicatie int alleen. `pain.001` (crediteurenbetalingen) komt niet in v1 of v2. Dit verwijdert het ernstigste fraudescenario volledig, tegen minimale functionele kosten.
- **Vier-ogen verplicht** op: wijziging van `vve.iban_exploitatie`, `vve.iban_reserve` of `incassant_id`; wijziging van een mandaat-IBAN; en het goedkeuren van een incassobatch. Een tweede persoon met een bestuursrol bevestigt in de applicatie; dezelfde persoon kan niet aanmaken én goedkeuren. Bij een VvE met maar één actieve bestuurder: expliciete, gelogde ontheffing met een waarschuwing in het scherm.
- **Out-of-band alarm.** Bij elke wijziging van een IBAN of van het incassant-ID gaat direct een e-mail naar **alle** bestuursleden én naar het oude e-mailadres van de gewijzigde persoon. Dit is de maatregel die een stille overname zichtbaar maakt.
- **Afkoelperiode:** na wijziging van een incasso-relevant IBAN kan er 24 uur lang geen incassobatch worden gegenereerd.
- **Herauthenticatie met MFA** op al deze handelingen, ongeacht een lopende sessie (§7.6).
- **Alleen op web**, nooit vanaf de mobiele app (§7.8).
- **Append-only grootboek** en een auditlog met hashketen waarvan het hoofdhash dagelijks naar buiten gaat (§6.8).
- **Maandelijkse controlemail** aan het bestuur: totaal geïncasseerd, aantal stornos, gewijzigde IBAN's, nieuwe mandaten. Een bestuurder die niets doet, ziet de afwijking alsnog.

### 8.6 Back-up, continuïteit en exit

- Dagelijkse versleutelde backup van database én documentopslag, offsite, append-only (§7.9). De versleutelingssleutels liggen apart.
- **Restore wordt getest**, elk kwartaal, met vastlegging van de doorlooptijd.
- **Exit-strategie als functionele eis:** elke VvE kan haar volledige administratie exporteren als ZIP met CSV's, alle documenten, alle PDF's en een leesbaar `overzicht.html`. Een VvE mag nooit gegijzeld worden door de software — en jij mag nooit het enige exemplaar van hun administratie zijn.
- **Bus-factor.** Jij bent single point of failure voor de hosting. Leg in `docs/` vast hoe de server opnieuw op te bouwen is, waar de sleutels liggen en wie erbij kan als jij er een half jaar niet bent. Voor de pilot-VvE is dat aanvaardbaar; vóór de derde VvE moet het geregeld zijn.

---

## 9. UI en UX

**Uitgangspunt:** de gebruiker is een vrijwilliger, geen boekhouder. Het systeem moet begeleiden en waarschuwen, niet alleen registreren.

**Twee schillen, één codebase:**

- **Eigenaarsportaal** (Ionic, PWA en native): rustig, weinig opties, mobile-first. Startscherm met mijn eenheid, mijn maandbijdrage gesplitst in exploitatie en reservefonds, openstaand saldo, laatste betalingen, mijn machtiging, komende ALV met stukken, mededelingen, actieve meldingen en de documentmap.
- **Beheeromgeving** (Ionic in de browser, desktopgerichte layout): dicht, veel data, tabellen met filters. Draait alleen op web (§7.8).

**Verder:**

- **Startscherm beheerder is een actielijst, geen leeg dashboard:** openstaande posten boven een drempel, ongematchte banktransacties, verlopende polissen, ALV zonder notulen, niet-afgesloten boekjaar, dotatie onder de wettelijke norm, mandaten met stornos.
- **Wizards** voor de complexe processen: *nieuwe VvE inrichten*, *bestaande VvE overnemen*, *begroting → bijdragen vaststellen*, *incassoronde uitvoeren*, *boekjaar afsluiten*. Elke wizard eindigt met een controlestap die alle consequenties op één scherm toont.
- **Onomkeerbare acties** (incassobestand genereren, boekjaar afsluiten, nota's verzenden) vragen een expliciete bevestiging met aantallen en bedragen, en staan in het auditlog.
- **Berekeningen zijn navolgbaar:** bij elk bedrag per eenheid een "hoe is dit berekend?"-uitklap met de posten, de sleutel, het gewicht en de afronding.
- **Toegankelijkheid:** WCAG 2.1 AA — contrast, toetsenbordnavigatie, labels aan velden, foutmeldingen bij het veld, geen betekenis alleen via kleur.
- **Taal:** Nederlands, alle teksten via `@ngx-translate` uit `nl.json` zodat Engels later toe te voegen is. Geen jargon zonder uitleg: bij "breukdeel", "verdeelsleutel" en "reservefonds" een informatie-icoon met één zin uitleg.
- **Offline gedrag:** de PWA toont een duidelijke offline-melding en blokkeert muterende acties in plaats van ze in de wachtrij te zetten. Een half verzonden nota-generatie is erger dan een foutmelding.
- **PDF-uitvoer** voor: nota, aanmaning, begroting, jaarrekening, afrekening, MJOP-rapport, ALV-oproep, notulen, stemlijst en debiteurendossier, met het logo van de VvE.

---

## 10. Integraties en bestandsformaten

| Formaat | Richting | Eisen |
|---|---|---|
| **CAMT.053.001.02/.08** | in | Dagafschrift; parse `Ntry`, `NtryDtls/TxDtls`, `RmtInf/Ustrd`, `EndToEndId`, `RltdPties`, saldi `OPBD`/`CLBD`. Eigen parser in `packages/domein/bank`. |
| **CAMT.054** | in | Storno- en incassomeldingen; koppel op `EndToEndId` en `RtrInf/Rsn/Cd`. |
| **pain.002** | in | Afwijzingen vóór verwerking; koppel op `OrgnlEndToEndId`. |
| **MT940** | in | Tags `:20: :25: :60F: :61: :86: :62F:`. Let op bankspecifieke `:86:`-structuren; ING en Rabobank verschillen wezenlijk. |
| **CSV bank** | in | Kolommapping per bankprofiel, opslaanbaar; encodingdetectie (UTF-8 / ISO-8859-1), scheidingsteken `,` of `;`. |
| **pain.008.001.02** (en `.08`) | uit | SEPA-incasso, gevalideerd met `xmllint --schema` vóór opslag. |
| **CSV / XLSX** | in/uit | Eenheden, eigenaren, MJOP, grootboekmutaties, openstaande posten, mandaten. |
| **ZIP** | uit | Documentmap en volledige VvE-export. |
| **ICS** | uit | ALV-afspraak voor de agenda van de leden. |
| **Push** | uit | Later, via Capacitor + FCM/APNs. Alleen signalering ("er staat een nieuwe nota klaar"), **nooit** bedragen of persoonsgegevens in de notificatietekst. |
| **PSD2 / bank-API** | in | Niet in scope. Houd de bankimport achter een interface `BankmutatieBron`, zodat een API-koppeling later een tweede implementatie is. |
| **Incasso-PSP** | uit | Niet in scope, wel voorbereid: mandaatbeheer achter een interface `MandaatBron`, zodat overstappen geen migratie is (jouw hybride keuze). |
| **pain.001** | uit | **Bewust buiten scope**, zie §8.5. |

**Validatieregels:** IBAN altijd mod-97 en lengte per land (`ibantools`); BIC afleiden waar mogelijk. Postcode `1234 AB`. KvK 8 cijfers. E-mail met een waarschuwende (niet blokkerende) MX-controle.

---

## 11. Kwaliteit, tests en Definition of Done

### 11.1 Verplichte testdekking

Zonder deze tests is een fase niet af. Tests 1–31 zijn ongewijzigd overgenomen uit versie 1.0 van dit document; 32–38 zijn nieuw en volgen uit de API-first-architectuur.

**Verdeling en afronding**
1. € 10.000,00 over 3 eenheden met gelijke delen → 3.333,34 / 3.333,33 / 3.333,33, som exact € 10.000,00.
2. Verdeling over breukdelen `125/1000`, `125/1000`, `250/1000`, `500/1000` → exacte som, deterministische restverdeling.
3. Eenheid met gewicht 0 krijgt € 0; het restant wordt over de overige verdeeld.
4. Jaarbedrag naar 12 perioden: som van de perioden == jaarbedrag, ook bij een bedrag dat niet deelbaar is door 12.

**Bijdragen**
5. Methode `uit_begroting` met drie kostenposten en drie verschillende sleutels levert per eenheid het handmatig nagerekende bedrag.
6. Methode `vast_bedrag` toont een correct dekkingstekort ten opzichte van de begroting.
7. Wijziging van een verdeelsleutel na vaststelling verandert geen reeds gegenereerde nota.

**Nota's en betalingen**
8. Deelbetaling zet de nota op `deels_betaald` met het juiste openstaande bedrag.
9. Vooruitbetaling levert een creditsaldo dat automatisch met de volgende nota verrekend wordt.
10. Nota-nummering is uniek en aaneengesloten per VvE per boekjaar, ook bij 50 gelijktijdige generaties (concurrency-test tegen een echte database).

**Bankimport**
11. Hetzelfde CAMT.053-bestand twee keer importeren voegt 0 nieuwe transacties toe.
12. Saldodiscontinuïteit tussen twee opeenvolgende bestanden wordt gedetecteerd en gemeld.
13. Afletteren op betalingskenmerk, op E2E-ID en op IBAN-HMAC + bedrag werkt; bij een afwijkend bedrag volgt alleen een voorstel.
14. Een MT940 van ING en één van Rabobank leveren dezelfde genormaliseerde transacties op (fixtures meeleveren).

**SEPA**
15. Gegenereerde pain.008 valideert tegen het XSD.
16. Eerste incasso op een nieuw mandaat krijgt `FRST`, de volgende `RCUR` (met `sepa.altijd_rcur` uit).
17. Een batch met een incassodatum binnen de aanlevertermijn wordt geweigerd.
18. Een storno heropent de nota, verhoogt de teller en blokkeert het mandaat bij de tweede keer.
19. Som van de posten == `CtrlSum` in het bestand, exact.

**Boekhouding**
20. Elke boeking heeft debet == credit; een onbalans gooit een fout en schrijft niets weg — óók wanneer de boekingsservice wordt omzeild (de deferred trigger moet afvangen).
21. Boekjaar afsluiten vergrendelt boekingen; muteren faalt daarna.
22. Afrekening: werkelijke kosten − voorschotten per eenheid; de som van de saldi == het exploitatieresultaat.
23. Eigenaarswissel halverwege het jaar verdeelt de afrekening pro rata over dagen; de twee delen tellen op tot het geheel.

**MJOP**
24. Indexatie: een element van € 10.000 met 2% index in jaar 5 → € 11.040,81.
25. Benodigde dotatie is de laagste dotatie waarbij het saldo in geen enkel jaar onder de ondergrens komt.

**Autorisatie**
26. Eigenaar A kan de nota, het document en de melding van eenheid B niet opvragen (404).
27. **Parametrisch over álle endpoints:** een token van VvE 1 op een resource van VvE 2 levert 403 of 404, nooit data. De test inventariseert de routes zelf, zodat een nieuw endpoint automatisch meedoet.
28. Een niet-geauthenticeerde request op elke beschermde route levert 401.

**Beveiliging**
29. Wachtwoord opnieuw versturen invalideert het oude wachtwoord én alle `apparaat_sessie`-rijen van dat account.
30. Een request met een onbekend veld in de body wordt geweigerd (mass assignment).
31. Upload met uitvoerbare inhoud onder een `.pdf`-naam wordt geweigerd op het gedetecteerde MIME-type.

**Nieuw — API, tokens en RLS**
32. **Opstarttest:** elke geregistreerde route heeft een `@VereistRecht`-declaratie; ontbreekt er één, dan faalt de applicatie bij het opstarten.
33. **RLS zelfstandig:** met de `vve_app`-rol, `app.vve_id` op VvE 1 en de applicatiescoping bewust uitgeschakeld, levert een `SELECT * FROM nota` uitsluitend rijen van VvE 1. Een query zonder gezette `app.vve_id` werpt een fout.
34. Eigenaarschap: twee gelijktijdige aandelen van 60% en 60% op dezelfde eenheid wordt geweigerd; 50% en 50% wordt toegestaan; een tweede volledig eigendom in dezelfde periode wordt door de exclusion constraint geweigerd.
35. **Refresh-rotatie:** een tweede gebruik van een reeds ingewisseld refresh token trekt de hele `familie_id` in en verstuurt een waarschuwingsmail.
36. **Mobiele beperking:** een token met `client: 'native'` krijgt 403 op incasso-, IBAN- en gebruikersbeheerendpoints.
37. **Vier-ogen:** dezelfde persoon kan een incassobatch niet zowel aanmaken als goedkeuren; een IBAN-wijziging blokkeert batchgeneratie 24 uur en verstuurt de alarmmail aan alle bestuursleden.
38. **Auditketen:** een handmatig gewijzigde of verwijderde auditregel wordt door `audit:verifieer_keten` gedetecteerd.

### 11.2 Definition of Done per fase

- Alle AC van de fase aantoonbaar gehaald.
- Tests groen tegen een echte PostgreSQL (Testcontainers); ESLint `strict-type-checked` zonder fouten; `tsc --noEmit` schoon.
- Migraties draaien schoon op een lege database én op de database van de vorige fase.
- Seeddata werkt: een demo-VvE met 8 eenheden, een jaar aan boekingen en een MJOP staat met één commando.
- Handleidingen bijgewerkt: `docs/handleiding-beheerder.md` en `docs/handleiding-eigenaar.md`, in gewone taal, met schermafbeeldingen.
- `docs/besluiten.md` bevat de ontwerpkeuzes van deze fase.
- Geen nieuwe afhankelijkheid toegevoegd zonder een regel in `docs/besluiten.md` waarom die nodig was (§8.2).

---

## 12. Faseplanning

Iedere fase is een bruikbare oplevering. Fase 1–3 samen vormen een administratie waarmee de pilot-VvE al volwaardig kan draaien.

> **Besluit: de pilot start zonder automatische incasso.** Tot en met fase 3 wordt uitsluitend per overboeking geïnd. Dat maakt het afletteren op betalingskenmerk (fase 3) van meet af aan de kritieke functie — en dat is dezelfde motor die incasso later nodig heeft. SEPA komt pas als de administratie draait en de gebruikers eraan gewend zijn, als aparte gecontroleerde uitrol met een testbatch.
>
> Wat daarvóór al wél gebouwd wordt, zodat incasso later geen verbouwing is: `betaalwijze` op de nota, een uniek betalingskenmerk per nota, de tabellen `sepa_machtiging`, `incasso_batch` en `incasso_post` in het schema, de IBAN-versleuteling (§6.2) en het interface `MandaatBron`. Alleen de schermen, de pain.008-generator en de stornoverwerking wachten.

**Fase 0 — Fundament**
Monorepo, NestJS-opzet, Drizzle-schema en migraties, PostgreSQL met RLS-rollen en -policies, authenticatie met refresh-rotatie, MFA, rechten- en tenantguards, auditlog met hashketen, mailwachtrij op pg-boss, `Bedrag`/`Verdeler`/`Klok`, Ionic-schil met routing en tokenopslag, Docker Compose, CI met tests en linting.

**Fase 1 — VvE, eenheden, gebruikers, documenten**
M1, M2, M3. Applicatiebeheerder maakt VvE en beheerderaccount aan (inclusief "opnieuw wachtwoord versturen"); beheerder maakt eenheden aan en nodigt eigenaren uit; documentenmodule met zichtbaarheid; eerste eigenaarsportaal. CSV-import van eenheden en eigenaren.

**Fase 2 — Begroting, verdeelsleutels, bijdragen, nota's**
M4, M5, M6 (zonder aanmaningen). Beide bijdragemethoden, openingsbalans, nota's genereren en als PDF versturen, handmatige betalingen, debiteurenoverzicht.

**Fase 3 — Bankimport, afletteren, grootboek**
M7, M9. CAMT.053 + MT940 + CSV, matchingmotor op IBAN-HMAC, werkbak, boekingsregels, grootboek, proef- en saldibalans, jaarrekening, afrekening servicekosten, boekjaar afsluiten, kascommissie-modus. Aanmaningstraject (M6 compleet). **Pilot-VvE gaat hier live — volledig op overboeking.**

**Fase 4 — SEPA-incasso, tijdens de pilot**
M8 volledig: mandaatbeheer met versleutelde IBAN's, digitale machtiging in het portaal, batchgeneratie met XSD-validatie en vier-ogen, vooraankondiging, stornoverwerking. Uitrol in deze volgorde: mandaten verzamelen → batch genereren maar niet indienen en handmatig narekenen → één testbatch met één eenheid → volledige ronde. Pas als een volledige ronde inclusief stornoverwerking foutloos is verlopen, gaat de VvE over van overboeking naar incasso.

**Fase 5 — MJOP en reservefonds**
M10 volledig: prognose, benodigde dotatie, wettelijke toets, scenario's, XLSX-import, MJOP-rapport als PDF.

**Fase 6 — Vergaderingen, meldingen, communicatie**
M11, M12, M13. ALV met agenda, oproeping, presentie, volmachten, stemmen en besluitenregister; meldingen; leveranciers, contracten en verplichtingenregister met signaleringen.

**Fase 7 — Native app**
Capacitor-build voor iOS en Android, push-notificaties, biometrische ontgrendeling, privacy-scherm, app-store-publicatie. Pas hier — niet eerder, want tot dit moment doet de PWA hetzelfde zonder reviewcyclus.

**Fase 8 — Verdieping (op volgorde van waarde)**
Volledige VvE-export/exit, PDF-tekstextractie en zoeken, incasso-PSP achter `MandaatBron`, PSD2-koppeling achter `BankmutatieBron`, verduurzamingsmodule (energielabel, maatregelen, subsidies, laadpalen), meertaligheid, hoofdsplitsing/ondersplitsing.

---

## 13. Seeddata en overname van een bestaande VvE

### 13.1 Demo-VvE (seed)

"VvE Zonnehof" — 8 eenheden (6 woningen van 45–110 m², 2 parkeerplaatsen), breukdelen samen 1000, MR2006, boekjaar = kalenderjaar, herbouwwaarde € 2.400.000. Begroting met 10 posten en 3 verdeelsleutels (algemeen op breukdeel, lift met uitsluiting van de begane grond, parkeerdek alleen voor parkeerplaatsen), maandbijdragen tussen € 85 en € 210, een jaar aan nota's en betalingen inclusief twee wanbetalers en één storno, een geïmporteerd bankafschrift als fixture, een MJOP met 12 elementen over 15 jaar, drie ALV's met notulen en besluiten, en een gevulde documentmap met dummy-PDF's.

### 13.2 Overnamewizard voor een bestaande VvE

De belangrijkste drempel voor adoptie; bouw dit als begeleide flow.

1. **VvE-gegevens**: naam, KvK, splitsingsakte uploaden, modelreglement, boekjaar.
2. **Eenheden** importeren of invoeren, met breukdelen en m². Controle op de som van de breukdelen.
3. **Eigenaren** importeren; uitnodigingen worden nog niet verstuurd.
4. **Bijdragen**: "ik heb vaste bedragen" (methode `vast_bedrag`) of "bereken uit de begroting".
5. **Openingsbalans per peildatum**: saldo exploitatierekening, saldo reservefonds, algemene reserve, openstaande debiteuren per eenheid en periode, openstaande crediteuren. Het systeem boekt dit als één openingsbalansboeking. Sluit de balans niet, dan gaat het verschil naar een zichtbare post "verschil openingsbalans" die blijft staan tot hij is opgelost.
6. **Machtigingen** importeren met hun oorspronkelijke kenmerk en ondertekendatum. Bij een gewijzigd incassant-ID worden de `AmdmntInf`-velden automatisch gevuld voor de eerstvolgende incasso.
7. **Documenten** in bulk uploaden met categorisering.
8. **MJOP** importeren of overslaan.
9. **Controlescherm** met alle waarschuwingen (breukdelen tellen niet op, dekkingstekort, dotatie onder de norm, eenheden zonder e-mailadres) — en pas dán de knop "uitnodigingen versturen".

---

## 14. Aannames en openstaande keuzes

| Onderwerp | Besluit | Toelichting |
|---|---|---|
| Stack | **NestJS + PostgreSQL + Ionic/Angular** | Vastgesteld. Eén taal over de hele stack; RLS als tweede slot. |
| Hosting | **Eén eigen server voor alle VvE's**, start met één pilot-VvE | Vastgesteld. Gevolg: je bent verwerker (§8.3) en single point of failure (§8.6). |
| Mandaten en IBAN's | **Zelf opslaan, versleuteld, PSP later mogelijk** | Vastgesteld. Kolomversleuteling met HMAC-zoeksleutel (§6.2), mandaatbeheer achter `MandaatBron`. |
| Client | **PWA eerst, native via Capacitor in fase 7** | Vastgesteld. Geen app-store-reviewcyclus die je releases blokkeert. |
| Automatische incasso | **Pas ná live-gang van de pilot** | Vastgesteld. Fase 1–3 draaien op overboeking; schema en interfaces worden wel meteen gebouwd. |
| Identiteitsbeheer | **In NestJS, achter interface `IdentiteitProvider`** | Vastgesteld. Geen Keycloak: geen federatie of delegatie nodig, en een tweede runtime met een eigen gebruikersadministratie op één VPS kost meer dan het oplevert. |
| Uitgaande betalingen | **Buiten scope** | `pain.001` verwijdert het zwaarste fraudescenario niet — het introduceert het. |
| Uitnodigingsmethode | Eenmalige instellink (default) of gemaild wachtwoord | Beide gebouwd, `auth.uitnodiging_methode` bepaalt welke actief is. |
| ORM | Drizzle | Prisma toegestaan, maar de RLS-koppeling is daar omslachtiger. |
| Btw | Geen btw-administratie in de kern | VvE's zijn in beginsel niet btw-plichtig. Module voor verhuurde bedrijfsruimte pas in fase 8. |
| Boekhouding | Volledig dubbel boekhouden vanaf fase 3 | Zonder dubbel boekhouden is geen jaarrekening mogelijk. |
| Hoofd-/ondersplitsing | Buiten scope tot fase 8 | Later `vve.moeder_vve_id` met doorbelasting via een sleutel. |
| Documentopslag | Lokale schijf buiten de webroot, achter interface `Bestandsopslag` | S3-compatibel later inwisselbaar. |
| Meertaligheid | Alleen Nederlands, wel via taalbestanden | Engels in fase 8. |

---

## 15. Beknopte acceptatie van het geheel

De applicatie is geslaagd als een vrijwillige penningmeester van een VvE van 12 appartementen:

1. binnen een uur zijn bestaande VvE kan overnemen inclusief openstaande posten;
2. elke maand met drie handelingen (nota's genereren → controleren → incassobestand uploaden bij de bank) de bijdragen int;
3. na het inlezen van het bankafschrift binnen vijf minuten weet wie er achterloopt;
4. in januari met één druk op de knop een jaarrekening en een afrekening per eenheid heeft die de kascommissie kan controleren;
5. in de ALV kan laten zien dat de reservefondsdotatie aansluit op het MJOP;
6. en dat elk lid dit alles op zijn telefoon kan terugvinden zonder te bellen.

En, even hard: dat een gestolen laptop, een gestolen telefoon of een gestolen databasedump géén van deze zes dingen mogelijk maakt voor een ander.
