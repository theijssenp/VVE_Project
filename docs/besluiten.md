# Besluitenlog — VvE-monorepo

Ontwerp- en afwegingen die tijdens de werkblokken zijn gemaakt. Elke keuze staat onder
een datum- en blok-ID, zodat een latere sessie niet opnieuw hoeft te raden waarom het zo is.

---

## F01 — Monorepo-fundament (08-09-2026)

**Keuze: ESLint flat config met `projectService` (type-aware) in plaats van een statische
`project:`-lijst.**
Reden: met npm workspaces en cross-pakket-imports is `projectService: true`
(typescript-eslint v8) stabieler dan een handmatige `parserOptions.project`-lijst die per
bestand moet kloppen. `tsconfigRootDir` wijst naar de repo-root, zodat elke workspace zijn
eigen tsconfig pakt. Config-/build-bestanden die buiten elk tsconfig vallen
(`eslint.config.mjs`, `vitest.config.ts`) staan in `ignores` en hebben daarom geen
`allowDefaultProject` nodig — zie de herzieningsnotitie onderaan dit blok.

**Keuze: `strictTypeChecked` aangezet, `stylisticTypeChecked` _niet_.**
Spec §7.1 vereist expliciet `strict-type-checked`. De stylistische regels (quotes, spaties,
komma's) botsen met Prettier. Formatting is Prettiers taak; linting is semantiek + types.
`@typescript-eslint/no-explicit-any` staat op `error` — een `any` moet dan commentaar-begroend
via `// eslint-disable-next-line @typescript-eslint/no-explicit-any` (spec: "geen `any`
zonder expliciete onderbouwing in commentaar").

**Keuze: `exactOptionalPropertyTypes` aan in `tsconfig.base.json`.**
Zorg dat optionele velden expliciet `undefined` toestaan en onbekend niet wordt doorgesluisd —
past bij de mass-assignment-verdediging via Zod `.strict()` (spec §7.5).

**Werkwijze workspace-oplossing: `paths` in tsc + resolve-aliases in Vitest, met
`projectService` voor de linter.**

- tsc gebruikt projectreferences (`apps/api/tsconfig.json` → `packages/contract`), zodat
  `npm run build` (`tsc -b` op de root) alle projecten bouwt in de juiste volgorde.
  De `apps/api`-tsconfig heeft _daarnaast_ `paths` naar de bron van `@vve/contract`,
  zodat type-aware linting in `apps/api/src/*.ts` de contracttypes oplost.
- Vitest lost `@vve/contract`/`@vve/domein` via een `resolve.alias` (naar `src/index.ts`) op,
  zodat `npm run test` de bron compileert via esbuild en geen `build` vóór `test` vereist.
- `experimentalDecorators` / `emitDecoratorMetadata` staan in de Vitest `esbuild.tsconfigRaw`
  genest in `compilerOptions` (niet los in `tsconfigRaw`), anders registreert NestJS de
  `/health`-route niet en eindigt de e2e-test met 404 (geen decorator-metadata).

**`apps/app` (Ionic/Angular) niet gescaffoldd.**
Spec §7.2 en F01 item 2 zeggen expliciet: "alleen de workspace-map met een geldige `package.json`".
De echte Ionic-schil is blok F11. De `apps/app/package.json` bevat alleen de workspace-naam,
`private: true`, één `@vve/contract`-dependency (zodat cross-workspace wiring reëel wordt) en
een no-op `build`-script — de echte app wordt niet vooruit gebouwd.

**Health-endpoint draad door de werkvloeden.**
`apps/api` valideert de response tegen `healthResponse` uit `@vve/contract` (via Zod `parse`).
Dat maakt de cross-workspace-wiring _reëel_ (niet lucht) en toetst tegelijk de contract-
structuur. De e2e-test gebruikt supertest + de Nest-testadapter (niet een directe controller-
call), precies zoals de opdracht voorschrijft.

**`no-restricted-imports`/`no-restricted-globals`/`no-restricted-syntax` op `packages/domein`.**
Enforcement van de pure-TS-regel (spec §7.2 "niet met goede voornemens"):

- `no-restricted-imports` blokkeert `@nestjs/*`, `drizzle-orm`, `pg`, `postgres` als imports.
- `no-restricted-globals` (value-positie) blokkeert `Date` en `fetch` als waarde. Dit
  is _de_ correcte plek: in TypeScript type-positie (`: Date`) is `Date` geen value-reference
  en wordt niet getriggerd.
- `no-restricted-syntax` vangt `new Date()` en `Date.now()`/`Date.parse()` als expressies;
  de selectors `[callee.object.name="Date"]` (CallExpression, `Date.now`) en
  `[callee.name="Date"]` (NewExpression, `new Date()`) dekken beide vormen expliciet.

## Afwijkingen

- **`@nestjs/testing`/`supertest` in `apps/api`'s `devDependencies`.** De opdracht noemt
  "Nest-testadapter _of_ supertest"; gekozen voor beide: supertest voor de HTTP-lager
  (het eindpunt reëel raken) en `@nestjs/testing` voor de module-samenstelling.
- **`apps/api/tsconfig.json` heeft `paths` + `references` naar `packages/contract`.**
  Strict genomen kan `apps/api` contract ook via de gepublishde `dist/`-build consumeren,
  maar dat betekent dat `build` vóór `lint` moet draaien. Met `paths` typecheckt de linter
  direct tegen de bron — de "npm ci, lint, test, build" CI-ordening slaagt dan ook.
- **`root build` = `tsc -b` zonder argument.** Dit bouwt alle projecten uit de root-
  `tsconfig.json` `references` (domein, contract, api, in volgorde). Dat is beter dan een
  hard-codd `tsc -b apps/api` die domein zou overslaan.

### Herziening na review (08-09-2026)

F01 voldeed aan zijn opdracht; `npm install && npm run lint && npm run test && npm run build`
slaagde. Bij een controle daarna zijn zeven punten aangepast. Ze staan hier omdat elk punt
een regel raakt die volgende blokken overnemen.

1. **`format:check` was niet blokkerend in CI.** De pipeline draaide alleen lint, test en
   build, terwijl vier bestanden (`README.md`, `docs/besluiten.md`, `infra/README.md`,
   `infra/docker-compose.yml`) al niet meer Prettier-conform waren. Bij blok 2 dreef de
   opmaak dus al uit elkaar. Toegevoegd als blokkerende stap; de vier bestanden zijn
   geformatteerd.
2. **`npm audit` ontbrak.** Spec §8.2 vereist een blokkerende SCA-scan. Toegevoegd als
   aparte job met drempel `high`, zodat een `moderate` bevinding in een devDependency de
   pipeline niet stillegt maar wel zichtbaar is.
3. **CI-rechten en concurrency.** `permissions: contents: read` (minimale GITHUB_TOKEN-
   rechten) en een `concurrency`-groep die verouderde runs annuleert.
4. **`apps/app/**` was volledig uitgesloten van ESLint.** Bedoeld als tijdelijke maatregel
   zolang de Ionic-map leeg is, maar het zou tot en met F11 een stille blinde vlek zijn
   gebleven. De map bevat nog geen `.ts`-bestanden, dus het weghalen van de uitsluiting
   verandert vandaag niets en sluit het gat voor later.
5. **`allowDefaultProject: true` stond op de verkeerde plek.** In typescript-eslint v8
   hoort die optie genest in `projectService` en verwacht hij een lijst globs, niet een
   boolean. Op deze plek deed hij niets. Verwijderd in plaats van gerepareerd: de
   betreffende bestanden staan al in `ignores`.
6. **`verdeelGrootsteRest` had geen bewaakte grenzen.** De uitkomst is exact zolang
   `totaal × gewicht` binnen `Number.MAX_SAFE_INTEGER` valt — een aanname die nergens
   werd afgedwongen. Nu een expliciete controle, net als een overloopcontrole op de
   accumulator van `somCenten`. De methode zelf is geverifieerd tegen een exacte
   BigInt-referentie over 250.000 willekeurige gevallen (inclusief bedragen tot € 20 mln
   en gewichten met vier decimalen): geen enkele afwijking.
7. **De test controleerde de volgorde niet.** Hij gebruikte `delen.sort()` — zonder
   comparator, dus lexicografisch (`[9, 10, 11].sort()` geeft `[10, 11, 9]`) — en toetste
   daarmee alleen de verzameling waarden, niet de toewijzing. Juist de volgorde ís de regel
   uit §5.2: bij gelijke fractie krijgt de laagste index de restcent. Zonder die regel kan
   dezelfde begroting op twee momenten een andere nota opleveren. De testset dekt nu de
   vier gevallen uit §11 (tests 1-4) met exacte arrays, plus fractionele gewichten,
   determinisme en de foutpaden.

**Geverifieerd, niet aangenomen:** de handhavingsregels op `packages/domein` vuren echt.
Een probe-bestand met `import { Injectable } from '@nestjs/common'`, `Date.now()` en
`new Date()` levert zes fouten op; een `Date` in typepositie (`nu(): Date`) niet. Dat laatste
was in dit document geclaimd maar nog niet getoetst, en klopt.

**Aandachtspunt voor volgende blokken:** het Nederlands in commentaar en documentatie bevat
regelmatig verschrijvingen ("blokket", "bewus", "gescaffoldd", "hard-codd"). Dit is de
huisstijl die latere blokken kopiëren; het loont om er nu op te letten.

---

## F02 — Docker Compose-fundament (08-09-2026)

Productie-omgevingsskelet conform spec §7.9 (Draaien en beheren) en §8.2 (toeleveringsketen).
Drie services: `postgres`, `api`, `caddy`. Dit blokket levert géén databasecode of migraties (F03).

### Base images op digest (spec §8.2: "vastgezette base image (digest, geen `:latest`)")

Opgehaald met `docker inspect --format '{{.RepoDigests}}'` op 08-09-2026 op deze machine
(Docker Desktop op macOS, Apple Silicon / arm64). Deze digests gelden voor de multi-platform
manifest; docker selecteert per host het juiste platform-archief:

| Image      | Tag         | Digest (manifest)                                                         |
| ---------- | ----------- | ------------------------------------------------------------------------- |
| `postgres` | `16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |
| `node`     | `22-alpine` | `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| `caddy`    | `2-alpine`  | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |

`node:22-alpine` is de base van zowel de `builder`- als de `runtime`-stage in
`infra/api.Dockerfile`. De digests zijn **manifest-list digests** — op een `linux/amd64`
CI-machine (`ubuntu-latest` in de CI) pakt Docker automatisch het AMD64-archief uit dezelfde
manifest, dus één digest dekt beide platformen.

### Keuze: Postgres niet publiek blootgesteld

Spec §7.9 vereist dat Postgres **niet aan het internet**. Realisatie:

- De enige poortmapping staat op **`127.0.0.1:5432:5432`** (default via
  `${POSTGRES_PORT_MAPPING:-127.0.0.1:5432:5432}`). Geen `0.0.0.0`.
- In productie zet de operator `POSTGRES_PORT_MAPPING=` leeg (in `.env`), zodat er op de
  host géén mapping is en Postgres alleen binnen het compose-netwerk (`vve_vve_net`)
  bereikbaar is door de `api`-service.
- De `api`-service heeft géén host-poort; `caddy` is de **enige** poort die naar buiten
  luistert (`0.0.0.0:80`).

### Keuze: lokaal HTTP op 80, TLS-automatisering uit

De opdracht zegt: "Voor lokaal draaien mag dat HTTP op poort 80 zijn; TLS-automatisering
voor productie noteer je als keuze (niet nu activeren)." De `infra/Caddyfile` werkt daarom
als pure `reverse_proxy api:3000` op `:80`. Voor productie zou de Caddyfile een domein-block
met automatische `https` (Letsencrypt, `caddy:2-alpine` doet dit vanzelf) krijgen; die
wissel is bewus uit dit blokket. De HSTS-header (spec §8.2) hangt daaraan vast en wordt
dus mee geactiveerd wanneer de productie-domein-block toegevoegd wordt.

### Keuze: `env_file: ../.env` met `required: false`

De `api`/`postgres`/`caddy`-services krijgen elk een `env_file: ../.env` met
`required: false`. Twee-reden:

- **Doel DoD**: `docker compose config` moet geldig zijn zonder dat de operator nog een
  `.env` heeft aangemaakt (de repo draait in CI zonder `.env`). `required: false`
  voorkomt dat een ontbrekend bestand de interpolatie stopt.
- **Doel productie**: de `.env` (met echte secrets) wordt door de operator lokaal aangemaakt
  via `cp .env.voorbeeld .env && chmod 600 .env` en is **buiten** git (`.gitignore`).
  Zolang de `.env` aanwezig is, overschrijft de daarin gezette `POSTGRES_PASSWORD` (en
  de overige secrets) de placeholder-defaults in de compose-file. De compose-file
  bevat **géén echte secrets** (spec §8.2: "Geen geheimen in de repository").

De `:?`-validatie (die de `.env` verplicht zou maken) is bewust op `${VARIABE:-default}`
gewijzigd, zodat de config ook zonder `.env` valideert. De defaults in de compose-file
(`POSTGRES_USER: vve`, `POSTGRES_PASSWORD: lokal`, …) zijn alleen voor de
interpolatie-validatie bedoeld; een operator vult ze in `.env` in.

### Keuze: `api.Dockerfile` — non-root via de ingebouwde `node`-user

De runtime-stage gebruikt `USER node` (UID 1000) — de in `node:22-alpine` reeds
ingeschreven user. Voordeel: geen extra `useradd`-laag (kleinere image), geen
root-container. De `node`-user heeft toegang tot `/repo` omdat de `COPY`-stappen vóór
`USER node` draaien en de default-permissies van de builder-stage overnemen.

### Keuze: build-context = monorepo-root

`build: context: ..` + `dockerfile: infra/api.Dockerfile` in een `infra/docker-compose.yml`
betekent dat de Docker build het **volledige monorepo** als context krijgt. Dit is nodig
om dat `npm ci` op de root alle workspaces (api, domein, contract) kan installeren en
`tsc -b` alles kan compileren vóór alleen `apps/api/dist` en `packages/*/dist` naar de
runtime-stage worden gekopieerd (devDependencies blijven uit de runtime-stage weg —
`npm ci --omit=dev`).

### Test (DoD) — resultaten op 08-09-2026

Alle drie de criteria groen:

| Stap                                                     | Resultaat                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `docker compose -f infra/docker-compose.yml config`      | **OK**                                                                         |
| `postgres` healthy                                       | Up (healthy), poort `127.0.0.1:5432->5432`                                     |
| `api` healthy                                            | Up (healthy), poort `3000` in het interne netwerk                              |
| `curl -s http://localhost/health` (via `caddy` op `:80`) | `{"status":"ok"}`, HTTP 200                                                    |
| `docker compose down` (volumes blijven)                  | **OK** — alle containers gestopt/verwijderd; volume `vve_postgres_data` intact |

### Herziening na review (08-09-2026)

F02 draaide aantoonbaar: `curl http://localhost/health` gaf via Caddy `{"status":"ok"}`
met alle healthchecks groen. De bevindingen zaten in wat er _niet_ gebeurde bij herstart,
en in twee documentatieclaims die niet klopten.

1. **De `.env` bereikte de container niet — het wachtwoord was `lokal`.** Dit was de
   ernstigste bevinding. Twee mechanismen bevochten elkaar: `environment:` heeft in
   Compose voorrang op `env_file:`, en interpolatie van `${...}` leest het
   `.env`-bestand naast de compose-file (`infra/.env`), niet de repo-root. Netto:
   de operator vulde een sterk wachtwoord in `.env` in, chmod 600 en al, en Postgres
   startte met de default `lokal`. Geverifieerd met een geïsoleerde compose-proef die
   exact deze opzet nabouwt.
   Opgelost door één mechanisme aan te houden: `env_file:` is overal verwijderd, alle
   waarden komen uit interpolatie, en het draaien gebeurt met `--env-file .env`.
   Op `POSTGRES_PASSWORD` staat nu `:?` in plaats van `:-lokal`, zodat het vergeten van
   de vlag hoorbaar faalt in plaats van stil een zwak wachtwoord te gebruiken.
   Het bestaande volume was met `lokal` geïnitialiseerd en is opnieuw aangemaakt; het
   bevatte alleen de kale initdb (geen migraties, geen schema — F03 was nog niet zover).
2. **De onderbouwing van de `:-`-defaults klopte niet.** In dit document stond dat de
   defaults nodig waren omdat "de repo in CI zonder `.env` draait". Er stond geen
   compose-stap in de CI (`grep -c compose .github/workflows/ci.yml` gaf 0). Die stap is
   nu wél toegevoegd, met `.env.voorbeeld` als invoer.
3. **Caddy had geen volumes.** Geen `caddy_data` betekent dat elke herstart nieuwe
   TLS-certificaten aanvraagt — bij de productie-omschakeling loop je dan direct tegen
   de Let's Encrypt-limieten. En de toegangslogs naar `/var/log/caddy/app.log` gingen
   bij elke `down` verloren, terwijl §7.9 logkanalen juist als bewaarde sporen behandelt.
   Toegevoegd: `caddy_data`, `caddy_config`, `caddy_logs`. Persistentie geverifieerd
   over een `down`/`up`-cyclus.
4. **Caddy kreeg de databasesecrets zonder ze nodig te hebben.** `env_file` stond ook op
   die service. Verwijderd (spec §8.1, minste rechten).
5. **Geen beveiligingsheaders.** `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy` en `Permissions-Policy` hangen niet van TLS af en kosten vier
   regels. Toegevoegd, plus `-Server`. HSTS en CSP volgen bij de https-omschakeling:
   HSTS heeft over plain HTTP geen effect en de CSP hangt af van de Ionic-bundel (F11).
6. **Caddy had geen healthcheck** terwijl de andere twee die wel hadden. Toegevoegd.
   Verder `no-new-privileges` op alle drie de services.
7. **Dubbele healthcheck-definitie voor de api** (Dockerfile én compose, met
   verschillende `start_period`). De compose-variant is verwijderd; `depends_on:
service_healthy` werkt gewoon op de HEALTHCHECK uit het image.

**Twee documentatieclaims waren onjuist en zijn gecorrigeerd in `infra/README.md`:**

- "De api-service start als `appuser` (UID 1001)" — het is `USER node`, UID 1000.
  Gecontroleerd met `id` in de draaiende container.
- "De postgres-container draait met `--network-alias postgres`" — die instelling stond
  nergens in de compose-file.

**En één claim die wél klopte, maar op twee plaatsen verkeerd was overgenomen:** dit
document zei terecht dat de digests manifest-list-digests zijn die beide platformen
dekken; de kopteksten van `docker-compose.yml` en `infra/README.md` beweerden het
tegenovergestelde (amd64-only respectievelijk arm64-only, met een instructie om ze te
vervangen). `docker manifest inspect` bevestigt een OCI image index met zowel amd64 als
arm64. Beide teksten zijn rechtgezet — anders "repareert" iemand later een werkende opzet.

**Nagemeten na de wijzigingen:** compose config OK met de vlag en hard falend zonder,
alle drie de services healthy, `{"status":"ok"}` via Caddy, de vier headers aanwezig,
het 39-tekens wachtwoord uit `.env` werkt over TCP, en de toegangslogs staan er na een
`down`/`up` nog.

### Afwijkingen en operator-keuzes

- **TLS / HSTS in productie is uit dit blokket.** Zie boven ("TLS-automatisering uit");
  de Caddyfile heeft bewust géén domein-block — de productie-wissel is een bewuste
  operator-keuze, niet een ontbrekende functionaliteit.
- **Locale mapping op `127.0.0.1:5432:5432`** is de default (spec §7.9: "voor lokaal
  ontwikkelen mag maximaal een mapping op `127.0.0.1` staan"). In productie:
  `POSTGRES_PORT_MAPPING=` leeg in `.env`.
- **Digest is een manifest-list digest** (niet een platform-specifiek SHA). Dit is de
  standaard Docker-praktijk: één digest voor zowel ARM64 als AMD64; Docker selecteert
  lokaal het juiste archief.

## F03 — Drizzle-operatie, migratierunner, Testcontainers-harnas en schema vve/persoon

(08-09-2026)

### Migratiestrategie

De migraties zijn **handgeschreven SQL** — de migraties zijn leidend, de
Drizzle-schema is de typeveilige tegenpartij. De SQL in
`apps/api/src/database/migraties/*.sql` wordt gedraaid door
`run-migraties.ts`, een pure Node-js-CLI die zelf een `migratie_historie`-tabel
legt en elke migratie in een eigen transactie uitvoert (BEGIN/COMMIT). Dit
biedt:

- **Idempotentiteit**: tweede `db:migrate`-run levert nul nieuwe rijen op;
  bewezen door `migraties.e2e-spec.ts` tegen een verse Postgres-16-container.
- **Geen kip-ei**: de historie-tabel wordt aangelegd via DDL
  (`CREATE TABLE IF NOT EXISTS migratie_historie`), vóór de eerste migratie
  zich in de historietabel inschrijft.
- **Geen drift between schema en migraties**: de testcontainers-helper
  gebruikt dezelfde `voerMigratiesUit(url)`-functie uit `run-migraties.ts`;
  de schema's (`src/database/schema/*.ts`) worden niet door drizzle-kit
  gegenereerd, maar handgeschreven als typeveilige tegenpartij.

### `apps/api` op ESM (latente F01-productiebrek gefixt)

De compiler-uitvoer `dist/src/main.js` bevatte al ESM-`import`-statements
(NodeNext `tsc` met `NodeNext`-module), maar `apps/api/package.json`
mistte `"type": "module"` — dus `node dist/main.js` zou op productie
een `ERR_MODULE_NOT_FOUND` geven (Node interpreteerde het als CommonJS).
Dit F03-work voegde dit veld toe; `node --check apps/api/dist/src/main.js`
bevestigt de syntactische ESM. Dit is een F03-fout, niet een F01-fout;
F01-testte alleen de health-check (die werkt via NestJS, niet via
`node dist/main.js` rechtstreeks).

### `drizzle.config.ts` en de ESM-migratierunner

De migratierunner (`run-migraties.ts`) gebruikt `import.meta.url` voor
map-resolutie, wat Node 22 native-type-stripping ondersteunt (via
`--experimental-strip-types`). Dit is bewust ESM:

- `import.meta.url` is de canonieke ESM-construct voor bestand-referentie.
  CommonJS-`__dirname` is geen goede oplossing in een monorepo waar het
  bestand vanuit meerdere plekken wordt gedraaid (npm-script van
  `apps/api`, of direct via `node`).
- De map-resolutie is **relatief ten opzichte van het scriptbestand**
  (niet ten opzichte van de working directory), zodat de script
  dezelfde bestanden pakt ongeacht vandaar waar hij start.

De `drizzle.config.ts` is bewust uit de tsc-include en de
eslint-`project`-conjecturen:

- Er is geen `drizzle-kit generate`-flow in deze repo. (Bij de review bleek er
  wél een `db:generate`-script te staan dat `drizzle-kit generate` aanriep; dat is
  verwijderd — zie de herzieningsnotitie hieronder.)
- De migraties worden handgeschreven; er is geen generate-flow die
  de config nodig heeft.
- De config is een declaratief document voor een mogelijk
  toekomstige `drizzle-kit generate`-run; hij is geen product-code.

### `Testcontainers`-harnas

Het harnas (`apps/api/test/testcontainers.ts`) start een
Postgres-16-container op het **exacte zelfde image/digest** als
`infra/docker-compose.yml`:

```
postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
```

De container draait lokaal op een willekeurige poort (testcontainers
kiest ze zelf, geëxposeerd via de connection URI). De
`gedeeldeTestDb()`-helper cacheert de container per
test-suite (één container gedeeld door `beforeAll`/`afterAll`),
zodat er per `it`-blok geen starttijd is. `stop()` in `afterAll`
stopt de container, zodat een volgende test-suite een frisse container
krijgt.

### `persoon.id` als `bigint GENERATED ALWAYS AS IDENTITY`

De `persoon.id` is een `bigint GENERATED ALWAYS AS IDENTITY`, niet
`char(2)`. Dit is consistent met de vve-id, en met de spec §6.3
die `bigint GENERATED ALWAYS AS IDENTITY` voorschrijft voor
primaire sleutels. Een `char(2)`-id zou een typebreuk veroorzaken
in later FK-referentie naar `persoon.id` (bijv. `rol_toewijzing`,
`passkey.persoon_id`, `uitnodiging.aangemaakt_door`, §6.3), die
`bigint` verwachten.

### Herziening na review (09-09-2026)

F03 haalde zijn DoD: `npm run lint && npm run test` groen met 21 tests, waarvan de
integratietests tegen een echte PostgreSQL-16-container via Testcontainers, en
`db:migrate` tweemaal gedraaid tegen een verse compose-Postgres — tweede run een no-op,
drie tabellen aanwezig. De migraties en het Drizzle-schema komen inhoudelijk overeen met
§6.1 en §6.3. Zes punten aangepast.

1. **De migraties konden niet in de productiecontainer draaien.** `tsc` kopieert geen
   `.sql`-bestanden naar `dist`, en `infra/api.Dockerfile` kopieert alleen `dist`. De
   migratiebestanden zaten dus niet in de image, terwijl de gecompileerde runner ze naast
   zijn eigen bestand zoekt. Dat was bij de live-gang (B11) aan het licht gekomen, op het
   slechtst denkbare moment. Eén `COPY`-regel toegevoegd; geverifieerd door de image te
   bouwen en de runner erin te draaien.
2. **Een mislukte migratie eindigde met exitcode 0.** De CLI draaide een async IIFE zonder
   `.catch`; een verbindings- of SQL-fout werd een unhandled rejection. Een falende deploy
   zou er dan geslaagd uitzien. Nu een expliciete vangst die naar stderr schrijft en
   `process.exitCode = 1` zet — in de image nagemeten.
3. **Geen bescherming tegen het bewerken van een reeds toegepaste migratie.**
   `migratie_historie` bewaarde alleen de naam en de eerste regel. Wie later een toegepaste
   migratie aanpast, krijgt stilzwijgend een database die niet meer met de bestanden
   overeenkomt. Nu een sha256 per migratie; wijkt die af, dan weigert de runner te draaien.
   Dat is wat "alleen voorwaarts" (§7.9) afdwingbaar maakt in plaats van een afspraak.
4. **Geen vergrendeling bij gelijktijdige runs.** Twee runners tegelijk — CI naast een
   lokale compose-start, of twee containers die opstarten — zouden dezelfde migratie
   tegelijk proberen toe te passen. `pg_advisory_lock` toegevoegd.
5. **Het `db:generate`-script sprak de eigen architectuur tegen.** Dit document stelt dat
   de handgeschreven SQL leidend is en dat er geen generate-flow bestaat, maar
   `apps/api/package.json` had `"db:generate": "drizzle-kit generate"`. Eén run daarvan
   zet een tweede bron van waarheid naast de migraties. Script verwijderd;
   `db:migrate:dist` toegevoegd voor het draaien vanuit `dist`.
6. **Een test die niets bewees.** `migraties.e2e-spec.ts` controleerde de volgorde met
   `ORDER BY naam` — dat toont alleen aan dat '0001' alfabetisch vóór '0002' komt, niet dat
   0001 eerder is uitgevoerd. Nu op `opgevoerd_op`, plus twee nieuwe tests voor de
   checksumbewaking. Van 21 naar 23 tests.

**Twee beweringen in dit document en één in de code klopten niet en zijn rechtgezet:** dat
er geen `drizzle-kit generate`-flow was (punt 5); en de kop van `test/testcontainers.ts`
die stelde dat `apps/api` CommonJS is en dat `run-migraties.ts` van `tsc -b` is uitgesloten
— het pakket is ESM (`"type": "module"`, in ditzelfde blok toegevoegd) en de runner staat
gewoon in `dist`.

**Procesincident.** Tijdens deze review bewerkte de bouwsessie `run-migraties.ts` terwijl
de reviewwijzigingen erin stonden. Een regelgebaseerde patch op verschoven regelnummers
liet een niet-parseerbaar CLI-blok achter. Hersteld door terug te gaan naar de commit en de
reviewwijzigingen opnieuw aan te brengen; de bedoeling van die bewerking (foutafhandeling
op de IIFE) is meegenomen als punt 2. Twee sessies in één werkboom is nu aantoonbaar een
risico, niet meer alleen een theoretisch bezwaar.

## F04 — RLS-fundament (09-09-2026)

**Keuze: policy op `vve` grijpt op `id` (de tenant-sleutel), niet op een
kolom `vve_id`.** De tabel `vve` ís de tenant; de kolom `vve_id` bestaat daar
niet. Op alle latere tenant-tabellen (eenheden, nota's, grootboek, …) heet de
kolom `vve_id` en volgt de policy het patroon uit §6.9 letterlijk
(`vve_id = current_setting('app.vve_id')::bigint`).

**Keuze: `persoon` krijgt géén RLS-policy op `app.vve_id`.** Personen zijn
tenant-overstijgend (§6.3): een eigenaar kan in meerdere VvE's zitten en moet
zich kunnen authenticeren vóór er een VvE-keuze is. RLS op `persoon` zou elke
login onmogelijk maken. Bescherming van persoonsgegevens loopt via de
API-autorisatie (§7.5) en de objectcontrole in de services; `rol_toewijzing`
en de sessietabellen krijgen in F06/F08 hun eigen policies.

**Keuze: `set_config(..., true)` als test-equivalent van `SET LOCAL`.**
`SET LOCAL app.vve_id = $1` met een query-parameter is in Postgres niet mogelijk
(structurieel, geen variabele). De productiehelper zet de instelling via
`sql.raw` met een gevalideerd safe-integer getal; de tests gebruiken
`set_config('app.vve_id', waarde, true)` — transactioneel equivalent.

**Gevonden Postgres-gedrag vastgelegd in de tests:** een `UPDATE` op rijen van
een ándere tenant faalt níét, maar raakt 0 rijen (USING filtert de rijen weg) —
precies de "lege resultset"-isolatie uit §6.9. De harde fout komt van
`WITH CHECK` bij INSERT/UPDATE die een ongeldige tenant-rij zou zetten. Beide
gedragingen zijn afzonderlijk getest.

**Grants in 0003 zijn bewust minimaal (schema-usage + rollen); tabel-grants
(`GRANT SELECT/INSERT/... ON ALL TABLES`) zet de test-setup per rol.** In het
echte productiepad loopt de applicatie als `vve_app` en geeft de migratie-rol
de grants per migratie mee; dat wordt in F06/F08 verder uitgewerkt.

### Herziening na review (09-09-2026) — F04

De policies en de tenanthelper zijn correct: `FORCE ROW LEVEL SECURITY` staat aan,
`USING` én `WITH CHECK` zijn gezet, `current_setting` zonder tweede parameter maakt het
fail closed, en `SET LOCAL` binnen de transactie is de juiste vorm voor pooling in
transaction-modus. Ook de keuze om `persoon` géén tenant-policy te geven is goed
onderbouwd: je moet een persoon kunnen lezen vóórdat er een VvE-keuze is. Drie punten.

1. **De applicatierol was onbruikbaar, en de tests verhulden dat.** Migratie 0003 gaf
   `vve_app` alleen `GRANT USAGE ON SCHEMA` — geen enkel tabelrecht — en liet de rol op
   `NOLOGIN`. Nagemeten op een verse database: `rolcanlogin = f` en nul privileges op
   `vve`. De RLS-suite slaagde omdat `beforeAll` zichzelf `GRANT SELECT, INSERT, UPDATE,
DELETE` uitdeelde. Een groen vinkje dekte daarmee precies het gat dat het moest
   aantonen. Migratie `0004_rls_grants.sql` toegevoegd met de tabelrechten plus
   `ALTER DEFAULT PRIVILEGES` voor latere tabellen; de grants zijn uit de testopzet
   verwijderd zodat de suite op de migratie steunt. `LOGIN` en wachtwoord blijven bewust
   buiten de migratie — dat zijn geheimen (§8.2) — en zijn een operatorstap.

2. **In de huidige configuratie beschermt RLS niets.** De applicatie verbindt met
   `DATABASE_URL`, en dat is de Postgres-superuser uit `infra/docker-compose.yml`.
   Een superuser omzeilt RLS volledig, ook met `FORCE`. Aangetoond op een verse database:
   als superuser geeft `SELECT count(*) FROM vve` zonder gezette `app.vve_id` gewoon beide
   tenantrijen; als niet-superuser faalt dezelfde query met
   `unrecognized configuration parameter "app.vve_id"`.
   **Harde eis voor F05 en verder: de applicatie verbindt als een rol met
   `vve_app`-lidmaatschap, nooit als eigenaar of superuser.** Anders zijn de policies
   decoratie. Na 0004 is dat pad geverifieerd: binnen tenant 1 ziet de rol 1 van 2 rijen,
   buiten een tenantcontext faalt de query, en een insert buiten de tenant wordt door
   `WITH CHECK` geweigerd.

3. **De migratietests hardcodeerden de volledige migratielijst.** Elke nieuwe migratie
   brak ze, wat uitnodigt tot het bijwerken van de verwachting in plaats van het lezen
   ervan. De verwachting wordt nu uit de bestanden afgeleid.

Verder faalde `npm run format:check` op twee F04-bestanden; die stap is sinds de
F02-review blokkerend in CI, dus deze commit zou daar zijn gestrand. Geformatteerd.

## F05 — Domeinpakket financieel (09-09-2026)

**Keuze: `Bedrag` met een privé-constructor die uitsluitend veilige gehele
centen accepteert (spec §7.3).** Geen enkele pad kan een float of NaN
binnenlaten: `vanCenten`, `vanInvoer` en de operaties bewaken
`Number.MAX_SAFE_INTEGER`. `maal(factor)` accepteert alleen gehele factoren —
1,5× een bedrag is geen geldige geldoperatie; verdeling gaat via de
`Verdeler` (grootste-restmethode, al geborgd in F01 als `verdeelGrootsteRest`).

**Keuze: parser weigert dubbelzinnige notatie in plaats van te gokken.**
"1.234.567" (punten zonder komma) is niet te onderscheiden van een decimale
punt-notatie met meerdere groepen en wordt geweigerd; "1.234,56" (punt als
duizendtal + komma) is eenduidig en wordt geaccepteerd. Presentatie volgt
§5.1: `€ 1.234,56`, negatief als `-€ 12.345,67`.

**Keuze: `Klok` als interface in het domein, implementatie in de
infrastructuurlaag.** `nu()` geeft UTC; `vandaag()` geeft een `KalenderDag`
(jaar/maand/dag) zonder tijdzoneconversie — kalenderdata zijn `date` (§5.8).
De Date-ban in het domeinpakket geldt vanaf nu alleen op productiecode; een
`*.spec.ts`-klok mag een concrete `Date` maken om zichzelf vast te zetten.

**Keuze: de cent-rekenkunderegel als eigen ESLint-plugin in de flat config**
(`vve/cent-rekenkunde`). Ze vlagt `+ - * / %`, compound-assignments en
`++/--` op identifiers of properties die op `_cent`/`_centen`/`Cent` eindigen,
over de hele repo. Vrijstelling alleen voor `packages/domein/src/financieel/**` —
dát is de plek waar de centen wél bewust worden gedaan (de Bedrag-implementatie
zelf). Dit maakt de spec-eis "Bedrag afdwingbaar in plaats van een suggestie"
(§7.3) werkelijkheid.

**Keuze: dubbele importroute op de barrel.** `@vve/domein` exporteert zowel
de namespaced vorm (`financieel.Bedrag`, zoals de F01-test al gebruikte) als
de vlakke vorm (`Bedrag` topniveau). Nieuwe code kiest één stijl; de vlakke
vorm is de aanbevolen voor nieuwe modules.

### Herziening na review (09-09-2026) — F05

`Bedrag` is zorgvuldig gebouwd: privéconstructor, veilige-integercontrole op elke bewerking,
gehele factor bij `maal`, en een `parseInvoer` die "1.234" (drie decimalen) liever weigert
dan gokt of het duizendtallen of decimalen zijn. `Klok` staat als puur interface in het
domein met de implementatie in de infrastructuurlaag — precies zoals §7.3 vraagt. Twee punten.

1. **De centrekenkunderegel miste juist de vorm die het schema gebruikt.** De regex was
   `/(_cent|_centen|Centen?)$/`. Dat `Centen?` betekent "Cente" met een optionele "n" — het
   matcht `Centen` en `Cente`, maar **niet** `Cent`. En dat is exact de vorm van de
   Drizzle-velden: `herbouwwaardeCent`, `bedragCent`, `exploitatieCent`, `reservefondsCent`.
   Gemeten met een probe: van vier rekenkundige uitdrukkingen op centvelden vuurde er één.
   Een guard die aanstaat, groen meldt en het merendeel mist is schadelijker dan geen guard,
   want hij schept vertrouwen. Regex nu `/(_cent(en)?|Cent(en)?)$/`; opnieuw gemeten: drie
   van drie, terwijl `percent`, `docent` en vergelijkingen (`>`) terecht ongemoeid blijven.
2. **`Verdeler` ontbrak.** De blokomschrijving noemt `Bedrag`, `Verdeler` én `Klok`; alleen
   de eerste en de laatste zijn gebouwd. Zonder die interface verzint elke aanroeper (G03
   verdeelsleutels, G05 bijdrageschema) zijn eigen conversie tussen `Bedrag` en kale
   getallen — precies wat het waardetype moest voorkomen. Toegevoegd als dun omhulsel om
   `verdeelGrootsteRest`, dat ongewijzigd blijft: die functie is al bewezen tegen §11
   tests 1–4 en tegen een exacte BigInt-referentie.

   Eén ontwerpkeuze daarbij: de restcent gaat bij gelijke fractie naar het **laagste
   eenheid-ID**, niet naar de invoegvolgorde van de `Map`. Anders zou dezelfde begroting een
   andere nota opleveren afhankelijk van de volgorde waarin de eenheden uit de database
   kwamen. Er is een test die de eenheden omgekeerd invoegt en aantoont dat de cent alsnog
   bij het laagste ID landt.

---

## F06a — Wachtwoordprimitives (09-09-2026)

Deelstuk 1 van F06 (spec §7.6, §8.2): de pure hashing- en sterkteprimitives in
`apps/api/src/gemeenschappelijk/auth/`. Tokens, sessies, de inlogflow en rate
limiting (test #29: "wachtwoord opnieuw versturen invalideert het oude
wachtwoord én alle `apparaat_sessie`-rijen") komen in latere deelstukken.

**Keuze: `argon2` als native dependency (spec §7.6 noemt `argon2id` expliciet;
§8.2 vraagt een nieuwe dependency met regel).** `argon2` (Node-bindings op de
libargon2-implementatie) is de in de spec genoemde, goed onderhouden
referentie. Het is de enige externe die F06a toevoegt; de zwakkere-
wachtwoordcheck gebruikt een lokaal ingebouwde lijst zodat er géén bredere
afhankelijkheid (zxcvbn, HIBP-netwerk) komt. Dit respecteert §8.2
("houd de afhankelijkhedenlijst kort"): de zwaktecheck is zelf geschreven.

**Keuze: argon2id met de OWASP 2023 baselines (19 MiB, 2 iteraties,
parallelism 1), als een aparte, gedeelde `HASH_PARAMS`-constante.**
De spec eist "veilige defaults (memory ≥ 19 MiB, iterations ≥ 2,
parallelism 1); kies en documenteer". Wij kiezen exact 19 MiB = `19 * 1024` KiB,
`t=2`, `p=1` — de minimum die OWASP in de 2023-richtlijn voor interactief
wachtwoordbeheer noemt (CPU-/GPU-resistentie met minimale latency op een
single-server-omgeving). Parallelism 1 past bij inlog (single-user, serial);
verhoog pas bij capaciteit. De parameters staan in één exporteerbare constante
zodat F06b (token-uitgifte) en de tests dezelfde waarde delen en de keuze één
plek herzienbaar is.

**Keuze: de PHC-string is het enige wat in de database gaat; de parameters
zelf zijn er ingebed.** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` bevat
salt én het exacte parameter-recept, dus een hash blijft verifieerbaar ook nadat
`HASH_PARAMS` in de toekomst wordt verhoogd. Er is dus geen aparte
"parameter-kolom" nodig in `persoon.wachtwoord_hash` (spec §6.2: `text`).

**Keuze: `verifieerWachtwoord` vangt een corrupte/ongeldige hash en geeft
`false` terug, in plaats van te wrachten.** Een ongebruikte/leeggevaarde
`wachtwoord_hash`-kolom (bv. een account dat alleen via passkey inlogt, of een
vergeten-wachtwoord-flow waarbij de hash alsnog leeg staat) is geen
foutmelding — het is een account waar dit wachtwoord voor niet werkt. De
aanroeper hoeft dus elke hash niet vóórhand te valideren. De
`argon2.verify`-implementatie wracht inderdaad op een mal-geformateerde
string ("pchstr must contain a $ as first char"); we vangen dat expliciet in
een `try/catch` en retourneren `false`.

**Keuze: de sterktebeoordeling combineert een zwartelijst met twee
triviaal-patronen (alleen-cijfers, naam/jaar) én een "kwetsbare stam"-check,
zonder ruwe substring-match.**
De spec eist "lengte ≥ 12 en niet veelgebruikt (lokale HIBP-lijst)". Wij
voegen naast de ~100-woorden-lijst twee regexen toe (`/^\d+$/`,
`/^[a-z0-9]{1,10}[-_ ]?(?:19|20)\d\d$/`) en een "letters-kern"-check: de
niet-letters worden verwijderd, dan wordt de kern op `KWETSBARE_STAMMEN`
getoetst (bv. "welkom" uit "welkom123"). De laatste check is bewust géén
substring-match op de hele string, om valse-positives op goede wachtwoorden
te voorkomen waar een kwetsbaar woord per toeval als substraat voorkomt.

**Keuze: geen extern HIBP-netwerk en geen zxcvbn in dit deelstuk.**
De spec §7.6 noemt "zxcvbn of een lokale HIBP-lijst" als alternatief. Wij
kiezen de lokale route in F06a en documenteren een vervolg: een vervolg-
blok (of een later F06b-iteratie) kan een grotere lokale HIBP-v1-lijst
(incl. het top-10k/1M) opnemen, of `zxcvbn` introduceren — maar dat is
geen blocking requirement voor de primitieven zelf. Een externe HIBP-API is
bewust verboden in dit deelstuk omdat `packages/domein`- en de
`apps/api`-modules I/O-vrij moeten blijven (§7.2) en een HIBP-netwerkcall
daar de uitzondering is die de testbaarheid breekt.

**Keuze: de primitives zijn puur en nestjs-vrij**, ook al is de
domein-ban (§7.2 "geen NestJS, geen db, geen Date/fetch") niet van toepassing
op `apps/api`. De reden is testbaarheid en herbruikbaarheid: de hash-functies
moeten vanuit een test zonder de Nest-container te bouwen aanroepbaar zijn.
Alleen `argon2` (een native hashing-bibliotheek) mag geïmporteerd worden;
geen `@nestjs/*`, geen `drizzle-orm`, geen `pg` — dus de code is
echt puur. De ESLint-bans in de root config gelden niet op `apps/api`,
dus dit wordt afdwongen via discipline in plaats van via een lint-rule.

### Tussentijdse review (09-09-2026) — F06a (wachtwoordprimitieven)

F06 is opgesplitst; dit is deel a. Vroegtijdig bekeken in plaats van na afronding, omdat dit
de eerste code is die de geldstroom raakt en er anders al deelstukken bovenop worden gebouwd.

De kern is goed: argon2id met expliciete parameters (19 MiB, t=2, p=1, de OWASP-2023-
baseline), de PHC-string bewaart die parameters zodat oude hashes verifieerbaar blijven, en
er is geen complexiteitsdwang — precies wat §7.6 vraagt. Geen `Math.random`, geen `Date.now`,
geen netwerk, en de zwarte lijst bevat publiek referentiemateriaal, geen geheimen. Drie
aanvullingen.

1. **Geen bovengrens op de wachtwoordlengte.** Argon2 hasht de volledige invoer, dus een
   inlogverzoek met een wachtwoord van enkele megabytes laat de server rekenen zolang de
   aanvaller wil: een goedkope denial-of-service tegen een dure KDF. `MEESTE_LENGTE = 1024`
   toegevoegd, afgedwongen bij hashen, verifiëren én beoordelen.
2. **Geen rehash-primitief, terwijl §8.1 dat expliciet eist** ("Rehash bij inloggen als de
   parameters veranderd zijn"). Zonder die stap blijven hashes met verouderde parameters
   onbeperkt staan, en beschermt het verhogen van de kosten alleen accounts die daarna nog
   een nieuw wachtwoord kiezen. `moetHerhashen()` toegevoegd; het aanroepen ervan in de
   inlogflow is werk voor F06b.
3. **`MOINSTE_LENGTE` hernoemd naar `MINSTE_LENGTE`.** Een exportnaam met een tikfout
   verspreidt zich over elk blok dat hem importeert; nu gecorrigeerd nu het nog één
   aanroeper heeft.

Open punt, bewust niet gerepareerd: de zwarte lijst telt circa 130 ingangen. §7.6 noemt
`zxcvbn` of een lokale HIBP-lijst; dit is verdedigbaar als eerste stap en de bouwsessie heeft
het vervolg zelf genoteerd, maar het is dun. Een grotere lokale lijst is een
afhankelijkheidsafweging die niet in een review thuishoort.

---

## F06b — Token-uitgifte, apparaat-sessies, refresh-rotatie (09-09-2026)

Deelstuk 2 van F06: de JWT-access-token, de opake refresh-token met rotatie en de
hergebruikdetectie, plus de DB-tabel `apparaat_sessie`, de Drizzle-schema's voor
`apparaat_sessie` en `rol_toewijzing`, en de migratie `0005`. Nog géén HTTP
(dat is F08/deelstuk 3), en de integratie met `mislukte_pogingen`/`geblokeerd_tot`
op `persoon` is eveneens niet in dit deelstuk.

### Nieuwe dependency: `jose` (verantwoord, spec §8.2)

§8.2 vraagt dat elke nieuwe dependency wordt verantwoord. `jose` vult de
JWT-eis uit §7.6 ("JWT, 15 minuten, in geheugen") en is de referentie-
implementatie die daarvoor ook wordt genoemd; de `zxcvbn`-keus (F06a) is
bewust uit dit deelstuk gehouden — die is breder dan nodig voor tokens.
`jose` is geen native binding (geen compilatiestap, alleen pure-JS
implementaties), dus de install is licht. Het is de één-en-alleen externe
dependency die F06b toevoegt.

### HS256 met symmetrisch omgevingsgeheim

Voor de first-party, single-server applicatie (§7.6) is HS256 met één
gedeeld `JWT_SECRET` het eenvoudigst dat de eis "met omgevingsgeheim"
toereikt: één sleutel tekenen én verifiëren, geen sleutelwissel per
uitgave, geen publieke sleutels die aan de client moeten worden
uitgedeeld. Per aanroep wordt de UTF-8 encoding van het geheim
(geen langdurend object) via `TextEncoder().encode()` opgebouwd,
dus de raw-bytes leven niet in een persistent state.
Overstappen naar ES256 (asymmetrisch) is mogelijk zodra signing
wordt uitgedefd van de requestpad; dat is géén eis van de spec en
daarom nu niet gepland.

### `refresh_token_hash` is `char(64)` sha256-hex; ruw token verlaat de db

Het ruwe refresh-token wordt met `crypto.randomBytes(32)` gegenereerd
en meteen na de uitgifte uit de geheugenlocatie verwijdert; in de DB
wordt alleen de sha256-hex opgeslagen (spec §8.2: "de ruwe token
verlaat de database nooit"). De lengte past exact in de
`char(64)`-kolom en de kolom is UNIQUE, zodat de hergebruikzoek
één rij oplevert (één hash, één sessie).

### Rotatie door toevoegen (nieuwe rij, oude ingetrokken)

Een `verfris`-aanbod in de actieve rij voert een rotatie uit in één
Postgres-transactie: de oude rij wordt ingetrokken (reden
`geroteerd`, geen `verloopt_op`-verlenging) óók is er een nieuwe
rij in dezelfde `familie_id` (met `vorige_token_hash` wijzend naar
het net-geconsumeerde token en met de `verloopt_op` van de oude)
toegevoegd. De levensduur wordt niet verlengd; een gestolen sessie
kunnen dus niet oneindig worden verlengd. De
transactie-structuur is bewust zo opgezet dat alle db-mutaties zich
in de transactie-rollback-callback afspelen en de _fout_
(HergebruikGesignaleerdFout, VerlopenTokenFout) éérst _na_ de
transactie — een throw in de callback zou anders de commit
ongedaan maken en de hergebruik-intrekking zou verloren gaan.

### Klok-injectie

`token.ts` neem een `Klok` aan (default `SystemKlok`) zodat
expiratie- en verloop-tests deterministisch draaien via een
verstelbare klok — geen timing-asserts (spec F06a). De `exp`-claim
wordt dubbel gevalideerd: jose (tegen de systeemklok — defence in
depth in productie) én expliciet via de geïnjecteerde klok
(zodat de verstelling in de tests effect heeft).

### Open punten (bewust buiten F06b)

- `mislukte_pogingen`/`geblokeerd_tot` op `persoon` (rate limiting,
  spec §7.6, 5 pogingen per 15 min): deelstuk 3 (F06c).
- `zxcvbn` of grotere HIBP-lijst: zie F06a-afdelingen.
- `needsRehash`-aansluiting bij inloggen (spec §8.1): deelstuk 3.
- Constante-tijdige afhandeling bij onbekende token (dummy-hash om
  het tijdsverschil te minimaliseren): de huidige `verfris`
  retourneert `OnbekendTokenFout` direct — een dummy-hash-ritueel
  is een verbeteringsrichting in F06c.

### Tussentijdse review (09-09-2026) — F06b (token-uitgifte en refresh-rotatie)

Goed gebouwd: opake refresh tokens van 32 bytes uit `randomBytes`, alleen de sha256-hex in
de database (`char(64) NOT NULL UNIQUE`), rotatie door een nieuwe rij in dezelfde
`familie_id` en hergebruikdetectie die de hele familie intrekt. De testset dekt precies de
juiste dingen, inclusief "het ruwe token staat niet in de database" en test #35. Het JWT-pad
klopt ook: HS256, `iss` en `aud` afgedwongen, `exp` dubbel gecontroleerd (jose én de
geïnjecteerde klok), `clockTolerance` op nul. Twee ingrepen.

1. **Een ingebakken terugvalwaarde voor het JWT-geheim — de ernstigste bevinding tot nu toe.**

   ```
   config.geheim ?? process.env['JWT_SECRET'] ?? 'dev-geheim-verander-dit-via-JWT_SECRET'
   ```

   Zonder `NODE_ENV`-guard. Ontbreekt `JWT_SECRET` in productie, dan tekent én verifieert de
   API met een waarde die in de repository staat. Wie de broncode of de image kan lezen,
   vervalst daarmee een geldig access token voor elke `persoon.id` — accountovername voor
   alle gebruikers, zonder spoor. De aanwezige lengtecheck van 16 tekens bood geen
   bescherming: de terugvalwaarde is 37 tekens.

   Het commentaar noemde dit "hetzelfde patroon als DATABASE_URL". Dat is precies het
   verschil dat telt: een verkeerde databaseverbinding faalt hoorbaar, een verkeerd
   JWT-geheim werkt perfect. Terugvalwaarde verwijderd; de service start niet zonder geheim
   en eist minimaal 32 tekens. `JWT_SECRET` toegevoegd aan `.env.voorbeeld` met een
   `openssl rand`-aanwijzing. Drie tests leggen het gedrag vast.

2. **Algoritme-allowlist toegevoegd** (`algorithms: ['HS256']`). Jose weigert met een
   symmetrische sleutel al een asymmetrisch algoritme of `none`, dus dit is verdediging in
   de diepte — maar de aanname hoort in de code te staan, niet in het hoofd van de lezer.

Dit is geen kwaadaardige achterdeur maar een gemakskeuze; het effect is niettemin een
universele vervalsingssleutel in de broncode. Precies de categorie waar blok F12 op moet
gaan letten.

## F06b — Token-uitgifte en apparaat-sessies (09-09-2026)

**Keuze: HS256 met een symmetrisch omgevingsgeheim (`JWT_SECRET`).** Voor een
first-party-app met één API is een asymmetrische sleutel niet nodig: er is geen
derde partij die tokens verifieert. HS256 houdt de eis "JWT met omgevingsgeheim"
(§7.6) eenvoudig en het geheim staat buiten de repo. Opgevolgd door F12:
een dev-default geheim in de bron is gemak, maar een vervalsingssleutel — daar
waarschuwt de wachtter voor.

**Keuze: opake refresh-tokens (32 bytes CSPRNG), alleen sha256-hex in de
database (`char(64) UNIQUE`).** Het ruwe token verlaat de database nooit; een
databasedump levert bruikbare refresh-tokens op. Rotatie per inwisseling:
de oude hash schuift door naar `vorige_token_hash`, de nieuwe rij (of kolom-
waarde) wordt actief. Hergebruik van een reeds geconsumeerd token trekt de
héle `familie_id` in (§7.6, test #35): de actieve rijen van die familie worden
met reden `hergebruik_gesignaleerd` ingetrokken en latere aanbiedingen weigeren
opnieuw met `HergebruikGesignaleerdFout`.

**Keuze: `apparaat_sessie` en `rol_toewijzing` zonder vve_id-RLS.** De sessie-
tabel is persoon-gebonden (§6.3); RLS op `vve_id` past niet en de API-scoping
(§7.5) beschermt de rijen. De default-privileges van migratie 0004 geven
`vve_app` de rechten; de migratie voegt zelf geen extra grants toe.

**Keuze: `SystemKlok` in `gemeenschappelijk/` die het domein-interface `Klok`
invult.** De infrastructuurlaag mag `Date` gebruiken (de domein-ban geldt op
`packages/domein`); de token-service injecteert de klok, zodat de verloop- en
rotatietests met een verstelbare klok deterministisch draaien.

**Migratie-censustest is dynamisch geworden:** de verwachte namen worden nu
uit de migratiemap gelezen in plaats van hard-coded — een nieuwe migratie
breekt de test niet, de checksum-test en idempotentietest blijven bewaken.

## F06c — Inlogflow, rate limiting en apparatenlijst (09-09-2026)

**Keuze: `mislukte_pogingen` als telling zonder venster-reset in deze laag.**
Spec §7.6 zegt "5 pogingen per account per 15 minuten". De telling zelf is
simpel op te hogen, maar het aflopende venster (pogingen vergeten na 15 min)
vraagt een achtergrondtaak of query-tijd. Bewuste vereenvoudiging: de blokkade
wordt gezet bij de vijfde opeenvolgende mislukte poging en loopt 15 minuten ná
die poging af; de kolom `geblokkeerd_tot` is de enige staat. Een geslaagde login
reset de teller én de blokkade. De IP-zijde (20/IP) hoort op de controller/HTTP-
laag (F08) met de echte aanvrager-adres; hier bewust niet gesimuleerd.

**Keuze: blokkade faalt vóór wachtwoordverificatie.** Is `geblokkeerd_tot` in
de toekomst, dan wordt het wachtwoord niet eens geverifieerd — een geblokkeerd
account kan niet gissen. `AccountGeblokkeerdFout` is een eigen foutklasse zodat
de controller er een 429/403 van kan maken; de melding noemt bewust geen
resterende tijd (geen account-enumeratie-assistent).

**Keuze: identieke melding en foutklasse voor onbekend e-mailadres, wachtwoord-
loos account, gedeactiveerd account en verkeerd wachtwoord.** `Onjuiste
InloggegevensFout` met exact de tekst "E-mailadres of wachtwoord onjuist"
(§7.6). De mislukte-pogingenteller loopt alleen op bij bekende accounts;
op een onbekend adres is er niets te tellen en dat is bewust zo.

**Keuze: de apparatenlijst toont alle sessie-rijen (historie incl.).**
`laatstGebruiktOp !== null` markeert actief gebruik; ingetrokken sessies
blijven zichtbaar met hun intrekkingsreden — het profiel mag zien wanneer
een apparaat is uitgelogd en waarom (§7.6). De echte "actief"-filter is een
controller-verantwoordelijkheid; de service levert de ruwe toestand.

**Opvolgnotitie:** de oplopende vertraging (§7.6) zit niet in deze laag; bij F08
(de guards/controllers) komt die op de HTTP-rand: 0/1/5/15/30/60 s per poging.
De vertraging moet dan vóór het antwoord, niet vóór de verificatie — anders
verliest de blokkade zijn functie.

### Herziening na review (10-09-2026) — F06c en afsluiting F06

De inlogflow is helder opgezet: één foutklasse voor onbekend adres én verkeerd wachtwoord,
blokkadecontrole vóór verificatie, teller gereset bij succes. Vier correcties, waarvan twee
die in productie merkbaar zouden zijn.

1. **De blokkade kon permanent worden gemaakt.** Na vijf missers werd het account 15 minuten
   geblokkeerd, maar `mislukte_pogingen` bleef daarna op 5 staan. De eerstvolgende misser
   telde door naar 6 en leverde meteen een nieuwe blokkade op. Wie alleen het e-mailadres
   kent, houdt een account daarmee onbeperkt dicht met één poging per kwartier — een
   gerichte denial-of-service tegen een individuele eigenaar. Een verlopen blokkade begint nu
   een nieuw venster; een regressietest legt dat vast.
2. **Onbekende accounts waren aan de responstijd te herkennen.** De melding was identiek,
   maar bij een onbekend adres keerde de functie direct terug terwijl een bestaand adres
   tientallen milliseconden argon2 kostte. Daarmee is de opsomming van bestaande accounts
   alsnog mogelijk — precies wat de identieke melding moest voorkomen. Er wordt nu tegen een
   vaste dummyhash geverifieerd. De bouwsessie had dit zelf als verbeterrichting genoteerd;
   dit was het blok waarin het thuishoorde.
3. **`apparaten()` merkte ingetrokken sessies als actief aan.** De vlag werd afgeleid uit
   `laatste_gebruikt_op`, en die wordt al bij uitgifte gezet. Juist in het scherm waarin
   iemand een gestolen sessie moet herkennen, stond die dus als actief. Nu op
   `ingetrokken_op IS NULL` én niet verlopen.
4. **`new Date()` in plaats van de geïnjecteerde `Klok`** (§7.3), waardoor de blokkadetermijn
   niet te testen was zonder werkelijk te wachten. `Klok` is nu verplicht in de config.

**Twee openstaande punten, bewust niet gerepareerd:**

- **Rate limiting per IP ontbreekt.** §7.6 vraagt 5 pogingen per account én 20 per IP, met
  oplopende vertraging. Alleen de accountgrens bestaat; `info.ip` wordt niet gebruikt. Een
  IP-teller vraagt om opslag en een keuze waar die leeft, wat bij de HTTP-laag (F08) hoort.
- **`moetHerhashen` wordt nog niet aangeroepen bij inloggen**, terwijl §8.1 dat eist en het
  primitief sinds F06a bestaat. De inlogflow is de enige plek met het platte wachtwoord in
  handen; zonder die aanroep blijven oude hashes staan.

Beide horen in F08 of een expliciet vervolgblok, niet in een review.

## F07 — MFA: passkeys primair, TOTP-terugval, herstelcodes, MFA-gate (09-09-2026)

**Keuze: otplib 13 met de plugin-API (NobleCryptoPlugin + ScureBase32Plugin).**
Otplib v13 vereist expliciete crypto/base32-plugins; de require is centraal in
totp.ts (CJS-bundel resolved onbetrouwbaar onder NodeNext met een statische
ESM-import). TOTP-parameters: 6 cijfers, 30 s periode, ±1 stapstolerantie
(standaard van de library).

**Keuze: de TOTP-versleuteling is een gemarkeerde plaatsvervanger tot B01.**
Spec §6.2 eist AES-256-GCM met de omgevingssleutel; die sleutelinfrastructure
komt in B01. Tot die tijd versleutelt een HMAC-sleutelstroom-XOR (prefix
"v0:") het secret, zodat er géén platte-tekst secrets in de database staan en
de kolomstructuur (bytea + versieprefix) alvast klopt. B01 vervangt de
plaatsvervanger en herversleutelt bestaande waarden.

**Keuze: herstelcodes als argon2-hashes in `persoon.herstelcodes_hash`
(text[]) zoals §6.3 al voorschrijft.** 10 codes van 4 bytes (8 hex), éénmalig
terug aan de gebruiker, verbruikte verwijderd uit de array. Verifiëren gaat
timing-veilig via de bestaande argon2-verificatie.

**Keuze: passkey-challenges in-memory met TTL (5 min) in de service.** De
controller (F08) kan ze ook aan de HTTP-sessie hangen; de module-structuur
maakt beide mogelijk. WebAuthn-registratie/asserties zelf zijn end-to-end te
testen in de PWA-flow (F11); hier zijn opties-generatie en challenge-beheer
gecontroleerd.

**Keuze: de MFA-gate als aparte bewaker op de geldstroomlijst (§7.6/§8.5).**
De lijst volgt de §8.5-handelingen (incassobatch genereren/goedkeuren, IBAN-
en incassant-ID-wijziging, mandaat muteren, boekjaar afsluiten, rol wijzigen).
Een recht uit de lijst mag alleen worden toegekend aan iemand met een passkey
óf geactiveerd TOTP; de gate is een service-functie die F08's RolGuard
aanroept vóór het toekennen. Herauthenticatie (opnieuw MFA op de handeling)
volgt in F08 met de sessie-context.

**Draaivolgorde migraties:** 0006 voegt alleen `passkey` toe; de
mfa-kolommen bestaan al sinds 0002. Censustest leest de map dynamisch en
breekt niet.

### Herziening na review (10-09-2026) — F07 (MFA)

De opzet klopt: TOTP-secret van 20 bytes via de otplib-cryptoplugin, herstelcodes als
argon2-hashes in `persoon.herstelcodes_hash` waarbij een verbruikte code uit de array
verdwijnt, en een MFA-gate op de geldstroomrechten. Twee ingrepen, allebei op gegenereerde
geheimen.

1. **Herstelcodes hadden 32 bits entropie.** `randomBytes(4)`, acht hex-tekens. Een
   herstelcode omzeilt de tweede factor volledig — het is een tweede wachtwoord, geen
   bevestigingscode. Met tien geldige codes per account is de zoekruimte om er één te raden
   ongeveer 2^29, en `verbruikHerstelcode` kent geen eigen begrenzing: de teller in de
   inlogflow zit op wachtwoordpogingen, niet hierop. Verhoogd naar 16 bytes (128 bits).

2. **Het TOTP-secret was met zelfgebouwde crypto en een vaste sleutel "versleuteld".** Een
   XOR met een HMAC-sleutelstroom, sleutel `VVE-TOTP-PLACEHOLDER-VERVANG-IN-B01` in de
   broncode, geen nonce en geen authenticatietag. Effect: een databasedump plus de
   repository levert het TOTP-secret van elke gebruiker op, en met dat secret genereer je
   zelf geldige codes — de tweede factor is dan weg voor iedereen. Bovendien deterministisch
   (dezelfde invoer geeft dezelfde bytes) en zonder integriteit, dus met schrijfrechten op
   de database ongemerkt te wijzigen.

   Het was eerlijk gemarkeerd als plaatsvervanger voor B01, maar B01 ligt in fase 3 en dit
   is live code die echte MFA-geheimen opslaat. Vervangen door AES-256-GCM met een sleutel
   uit `KOLOM_SLEUTEL`, opslagformaat `v1:` ‖ nonce(12) ‖ ciphertext ‖ tag(16) conform §6.2,
   met het e-mailadres als AAD zodat een ciphertext niet naar een andere rij te verplaatsen
   is. Geen terugvalwaarde: ontbreekt de sleutel, dan start de dienst niet. Drie tests leggen
   vast dat geknoei wordt opgemerkt, dat de context bindt en dat de nonce per keer verschilt.

   B01 hoeft deze functies straks alleen naar een gedeelde module te verplaatsen en er de
   IBAN-kolommen op aan te sluiten; het formaat is al het formaat dat §6.2 voorschrijft.

Bestaande rijen met het oude `v0:`-formaat zijn niet meer leesbaar. Dat is hier zonder
gevolg — er draait nog geen omgeving met echte gebruikers — maar het is de reden om dit nú
te doen en niet na de pilot.

## F08 — Guards, rechtdeclaraties en Zod-validatie (09-09-2026)

**Keuze: de opstarttest als expliciet route-register (test #32).** In plaats
van de interne Nest-router-stack te introspecteren (kwetsbare privé-structuur)
registreert elke module zijn routes in `route-inventaris.ts`; de
registerfunctie weigert een registratie zonder recht, zodat een route zonder
`@VereistRecht` onmogelijk in de lijst komt. `inventariseerRoutes()` is de
opstarttest-bron: de test controleert dat élke geregistreerde route een recht
draagt. De runtime-achtervang (RolGuard weigert zonder metadata) blijft
bestaan — twee lagen op dezelfde regel.

**Keuze: `vve_id`- en `mfa`-claims in het access-token.** De TenantGuard leest
de tenant uitsluitend uit het token (§7.5 stap 2: de client kiest niets); het
token draagt de VvE-keuze van de inlog. De `mfa`-claim markeert een
herauthenticatie (§7.6) — de RolGuard eist hem vóór geldstroomrechten (F07-gate).
De claims worden typeveilig geparseerd (string→bigint met regex-veto).

**Keuze: ZodValidationPipe met `.strict()` en beperkte foutdetails.** De pipe
gooit één `BadRequestException` met alleen het foutpad ("Ongeldige invoer op
naam") — geen stack, geen volledige issue-lijst naar de client (§8.2). De
schema's zelf volgen straks per module in `packages/contract`; de health-module
gebruikt ze al (F01).

**Nog open in dit blok:** de daadwerkelijke registratie van de guards op de
Nest-app (APP_GUARD-providers in de bootstrap) — bewust hier niet aangezet:
zodra HealthModule globaal guards draagt moet de health-route een recht en een
tenant-claim hebben; dat hoort bij de eerste functionele module (V01), niet bij
de guard-bouwstenen.

### Herziening na review (10-09-2026) — F08 (guards)

De guards zelf zijn goed: de `TenantGuard` leest `vveId` uitsluitend uit het gedecodeerde
token en de verzoek-interface geeft alleen `headers`, dus een tenant uit de body kán er
niet in — dat is de eis van §7.5 stap 2 afgedwongen door de vorm van de code en niet door
oplettendheid. De Zod-pipe weigert onbekende velden en lekt geen stacktraces. Eén ingreep,
maar een fundamentele.

**Test #32 controleerde een handmatig register in plaats van de werkelijke routes.**
`route-inventaris.ts` hield een lijst bij waarin modules zichzelf moesten inschrijven met
`registreerRoute(...)`. De controle wierp alleen wanneer iemand zich inschreef mét een leeg
recht. Wie vergeet zich in te schrijven — het geval waarvoor de controle bestaat — kwam
simpelweg niet in de lijst voor en glipte erdoor.

Dat was hier niet theoretisch: `HealthController.health()`, de enige echte route in de
applicatie, had **geen** `@VereistRecht`-decorator. De inventaris beweerde van wel, omdat de
regel `GET /health → health.lezen` hardgecodeerd onderaan het registerbestand stond. En
`main.ts` riep de controle helemaal niet aan, dus er was geen opstartcontrole.

Vervangen door inventarisatie uit de Nest-metadata van de controllers (`PATH_METADATA` en
`METHOD_METADATA` via `Reflect`), met `controleerRouteDeclaraties()` als aanroep in
`bootstrap()` vóórdat er iets luistert. `@VereistRecht('health.lezen')` staat nu op de
health-route zelf. Handler-declaratie wint van klasse-declaratie.

Drie tests: de echte routes zijn gedeclareerd (inclusief de assertie dat de inventaris
`GET /health` daadwerkelijk vindt — anders zou een hernoemde Nest-sleutel de controle stil
altijd laten slagen), een controller zónder decorator wordt gedetecteerd, en de
klasse-versus-handler-voorrang klopt. Ter controle is de decorator tijdelijk weggehaald: de
test faalt dan, zoals bedoeld.

De metadatasleutels staan als letterlijke waarden in het bestand, omdat
`@nestjs/common/constants` onder `moduleResolution: NodeNext` niet resolvet. Dat is de reden
voor die eerste assertie.

## F09 — Auditlog met hashketen (09-09-2026)

**Keuze: de keten over álle rijen, niet per VvE.** De kolom `vve_id` is
informatief (doorklik, filtering); de keten loopt door de tijd als één lijn —
`vorige_hash` verwijst naar de vorige rij op `id` (identity is stijgend). Een
globale keten is strenger dan per-VvE-ketens: een verwijdering breekt hem
altijd, ongeacht in welke VvE de betreffende rij stond.

**Keuze: canonieke JSON met sleutel-gesorteerde volgorde en ISO-8601-timestamps.**
De hash is deterministisch: dezelfde rij-inhoud levert dezelfde hash op,
ongeacht de kolomvolgorde in de database of de invoerorde van de structuur.
De timestamp in de hash is de **opgeslagen** waarde (`gebeurtenis_op` uit de
rij), niet een opnieuw-genereerde — de verificatie rekent met de
database-toestand.

**Keuze: de applicatierol verliest UPDATE/DELETE/TRUNCATE expliciet in 0007**
(REVOKE na de brede default-privileges van 0004) en krijgt alleen INSERT
(§6.8). Ook `vve_platform` kan het log niet muteren. Het teruglezen voor
verificatie gebeurt via de migratierol — de dagelijkse taak draait buiten de
requestverwerking (§7.9).

**Keuze: het dagelijkse hoofdhash-publiceren is bewust níet in dit blok.** De
verificatie (`verifieerKeten`) levert de hoofdhash; de verzending naar buiten
(e-mail aan het bestuur, §7.9) is de taak `audit:verifieer_keten` in F10
(pg-boss + mailwachtrij) — daar hoort de externe publicatie thuis, met de
mailinfrastructuur.

**Test #38 is op twee manieren bewezen:** een handmatige UPDATE van een rij
(details vervalst) wordt door `verifieerKeten` gedetecteerd met de rij-id in
`KetengebrokenFout`, en een DELETE van een middelste rij breekt de keten via
het vorige_hash-hiaat. Beide aanvallen doen zich als database-eigenaar — de
dreiging waar §6.8 over schrijft.

### Herziening na review (10-09-2026) — F09 (auditlog)

Dit blok is goed getest, en dat is opvallend genoeg om te noemen: de suite dekt niet alleen
de wijziging maar óók de **verwijdering** van een regel, en de alleen-INSERT-rechten worden
werkelijk als `vve_app` beproefd in plaats van met rechten die de test zichzelf geeft. Dat
is precies waar F04 en F08 struikelden. Eén defect.

**De keten vertakte onder gelijktijdigheid.** `registreer()` las de kop van de keten en
schreef daar los van elkaar achteraan. Twee gelijktijdige schrijvers lezen dan dezelfde
voorganger en krijgen hetzelfde `vorige_hash`. Gemeten met twintig gelijktijdige
registraties tegen een verse database: **alle twintig kregen `vorige_hash = NULL`** — elke
schrijver dacht de eerste te zijn. Er was geen keten, maar twintig losse wortels.

Dat is geen randgeval: het auditlog wordt bij elke muterende request geschreven (§7.5 stap
7), dus gelijktijdigheid is de normale toestand. Een vertakte keten maakt de dagelijkse
verificatie waardeloos — die slaat dan constant alarm, en een alarm dat altijd afgaat wordt
genegeerd. Daarmee is de manipulatiebestendigheid weg, terwijl het logboek er intact uitziet.

Opgelost door het lezen van de kop en het schrijven van de regel in één transactie te zetten
met `pg_advisory_xact_lock`. Nagemeten: twintig gelijktijdige registraties leveren nu één
rechte lijn op, elke schakel wijzend naar de `eigen_hash` van zijn voorganger.

De bestaande tests zagen dit niet omdat ze netjes één voor één registreren.

**Kort een unieke index geprobeerd en weer teruggedraaid.** Een `UNIQUE ... NULLS NOT
DISTINCT` op `vorige_hash` zou een vertakking ook buiten de service om onmogelijk maken.
Maar §8.3 schrijft een bewaartermijn van drie jaar voor het auditlog voor: oude regels worden
opgeschoond, waarna de oudste overgebleven regel naar een verwijderde voorganger wijst en een
nieuwe NULL-start kan ontstaan. Zo'n index vecht dan met voorzien gedrag. De vergrendeling
alleen is de juiste maatregel.

**Afwijking van de spec, ter beslissing.** De kolommen heten `gebeurtenis`, `categorie`,
`onderwerp_tabel`, `onderwerp_id`, `details`, `ip_adres`, `gebruiker_agent` en
`gebeurtenis_op`, waar §6.8 `actie`, `entiteit`, `entiteit_id`, `oud_json`, `nieuw_json`,
`ip`, `user_agent` en `tijdstip` noemt. De toevoeging `categorie` (app/financieel/beveiliging)
is een verbetering: die sluit aan op de logkanalen uit §7.9. Maar `oud_json` en `nieuw_json`
zijn samengevoegd tot één `details`-kolom, en daarmee verdwijnt de expliciete voor-en-na van
een wijziging — juist wat een auditlog bruikbaar maakt bij een geschil. Niet gewijzigd: een
kolomhernoeming raakt de interceptor uit dit blok en is een keuze, geen defect.

## F10 — pg-boss, mailwachtrij, verzendworker (09-09-2026)

**Keuze: pg-boss 12 voor de terugkerende taken, met de taakinhoud als dunne
functies.** De scheduler (schedule) en de worker (work/send) zijn gescheiden:
de taakinhoud — mailverwerking en auditverificatie — is een gewone functie
die de services aanroept. Tests draaien de inhoud deterministisch zonder
scheduler; pg-boss plant in productie (mail:verwerk elke minuut,
audit:verifieer_keten dagelijks om 06:00 Europe/Amsterdam).

**Keuze: de mail zelf in een eigen tabel (`mail_wachtrij`), níét in pg-boss.**
pg-boss beheert zijn eigen schema en zijn levensduurbeleid; de mail (inhoud,
ontvanger, status, bewijslast §13.5) hoort in de applicatieadministratie —
de tabel is querybaar en exporteerbaar, pg-boss-state niet.

**Keuze: de statusflow wachtend → bezig → verzonden | mislukt met een
optimistische claim.** De worker claimt per rij met een UPDATE ... WHERE
status = 'wachtend' (returning); een overlappende run ziet de rij niet meer en
slaat hem over — idempotent zonder een aparte lock-tabel. Fout → exponentiële
backoff (aflever_vóór +2^n minuten) met max 5 pogingen vóór 'mislukt'
(§7.7); de foutmelding blijft in de rij (§13.2).

**Keuze: de verzender als injecteerbare interface.** Nodemailer zit in de
productiecompositie; de tests injecteren een nepverzender. Daarmee is de
backoff-flow getest zonder een SMTP-server en zonder echte mail.

**Keuze: de audit-hoofdhash-publicatie zit in de taakregisseur.**
`auditVerificatieTaak` roept `verifieerKeten` (F09) aan; de dagelijkse
verzending aan het bestuur (§7.9) gaat via de mailwachtrij (categorie
'beveiliging') — die koppeling volgt bij de eerste functionele module die mail
verstuurt (V01), zodat het sjabloon met de infrastructuur meegroeit.

### Herziening na review (10-09-2026) — F10 (mailwachtrij)

De worker is correct gebouwd. De claim gebruikt een compare-and-set
(`UPDATE ... WHERE id = ? AND status = 'wachtend'` met `.returning()` en een controle op
`undefined`), dus twee overlappende runs kunnen niet dubbel versturen — precies de
idempotentie die §7.7 vraagt, en beter dan de adviesvergrendeling die ik elders nodig had.
Exponentiële backoff, maximaal vijf pogingen, en een SMTP-fout bereikt de aanroeper niet.

**Eén toevoeging: gevoelige berichten laten hun inhoud niet achter.** De wachtrij bewaart de
opgemaakte berichttekst, en §8.3 geeft die twee jaar bewaartermijn. Voor gewone post is dat
nuttig — bij een aanmaning wil je later kunnen aantonen wát er is verstuurd. Maar de knop
"opnieuw wachtwoord versturen" (§3.3) zet een gegenereerd wachtwoord in diezelfde tekst, en
dan staat dat wachtwoord twee jaar leesbaar in de database en in elke back-up, terwijl het na
aflevering nergens meer voor nodig is.

Toegevoegd: een `gevoelig`-vlag (migratie 0009). Staat die aan, dan wist de verzendworker de
tekst zodra de aflevering is geslaagd; de regel zelf blijft, zodat het bewijs dát er iets is
verstuurd bewaard blijft. Een test legt vast dat de ontvanger het geheim krijgt en dat het
daarna niet meer in de wachtrij staat.

Dit is een toevoeging en geen defect: de flow die het nodig heeft bestaat nog niet. De
wachtwoordgenerator stond tijdens deze review ongecommit in de werkboom, dus dit was het
moment om het veilige pad beschikbaar te maken — vóórdat het blok dat de mail samenstelt
erop aansluit. **Het blok dat de wachtwoordmail bouwt, moet `gevoelig: true` zetten.**

## F12 — Beveiligingswachters (09-09-2026)

**Keuze: statistische proof op de wachtwoordgenerator over 1 mln trekkingen.**
De generator (`wachtwoord-generator.ts`) gebruikt node:crypto-randomBytes met
rejection sampling — de byte-waarden die eerlijk over het alfabet verdeelbaar
zijn blijven over, de rest gaat weg. Daarmee is er per trekking exact-equal
kans per symbool: geen modulo-bias. De tests bewijzen lengte, alfabetdekking
(56 symbolen), χ²-uniformiteit (df 55, α=0.001, χ² < 91), 100k wachtwoorden
zonder duplicaten en een max/min-frequentieverhouding < 1.05.

**Keuze: de beveiligingswachters als één plugin met twee rule-blokken.**
ESLint flat config staat geen herdefinitie van een plugin over config-blokken
toe (`Cannot redefine plugin "vve"`); de regels delen één plugin-instantie en
de ignores die per regel verschillen (F05: de geldlaag `packages/domein/
financieel`; F12: `*.spec.ts`/`*.test.ts`) zitten op de twee blokken die de
plugin hergebruiken.

**De vier wachters:**

1. `Math.random` buiten testbestanden verboden — node:crypto (CSPRNG) of een
   geïnjecteerde bron; Math.random is niet cryptografisch.
2. `===`/`!==` op identifiers met token/hash in de naam verboden, behalve
   vergelijkingen met een literal (null/undefined-checks zijn bereikvragen,
   geen geheimvergelijking); geheimvergelijking loopt via timingSafeEqual.
3. `createCipheriv` met een letterlijke IV verboden — een vaste IV maakt de
   versleuteling deterministisch; de IV moet per bericht nieuw en willekeurig.
4. Identifiers die met secret/wachtwoord/sleutel gaan door console/log/
   audit-functies verboden (§8.2: geen geheimen in logs).

**De wachters zijn bewust op F12-niveau en niet op domein-niveau:** de
testbestanden zijn uitgezonderd (een nepklok mag Math.random-nabootsing
gebruiken; de statistische test telt honderdduizenden trekkingen), en de
geldlaag houdt zijn bewuste centenrekenkunde.

## F11 — Ionic-schil (10-09-2026)

De clientschil: routing, tokenopslag, HTTP-interceptor, foutafhandeling en de inlog- en
MFA-schermen. PWA eerst (§7.8); de Capacitor-build is blok N01.

### Keuze: Angular 21, niet 22

Angular 22 eist TypeScript `>=6.0 <6.1`, en de monorepo draait op 5.9.3 — met NestJS,
Drizzle en de bestaande strict-instellingen eraan vast. Angular 21 vraagt `>=5.9 <6.0` en
past dus precies. Ionic 9 accepteert Angular vanaf 18, dus die combinatie is vrij.
Doorstappen naar Angular 22 is een aparte beslissing die begint bij TypeScript over alle
workspaces, niet iets om in de schil mee te nemen.

### Twee installatiehobbels, en wat eronder zat

`npm install` liep vast op `Cannot read properties of null (reading 'edgesOut')` — een bug in
npm's arborist die afging op het peer-net van `@angular/build`. Dat pakket noemt `vitest ^4`
als peer terwijl de repo op 3.2.7 zit, maar die peer is **optioneel**: npm hoefde hem niet op
te lossen en crashte er toch op. Geïnstalleerd met `--legacy-peer-deps`; nagemeten dat vitest,
TypeScript en NestJS ongewijzigd bleven. `npm ci` in de CI leest de lockfile en doet geen
peer-resolutie, dus daar verandert niets.

Daarna faalde `npm audit --audit-level=high` op vier bevindingen. Die kwamen **niet** van
Angular: `multer` stond al op 2.2.0 vóór deze wijziging en er is sindsdien een advisory voor
gepubliceerd (denial-of-service via een geprepareerde multipart-body). Dat had de CI hoe dan
ook rood gezet. Opgelost met een override naar `multer ^2.3.0`.

### Waar de tokens staan (§7.6)

Het access-token leeft **alleen in het geheugen**, in een klasse met een privéveld. Het wordt
nergens bewaard: vijftien minuten geldig, en na een herlaadactie haalt de client een nieuw
exemplaar op.

Voor het refresh-token verschilt het pad per platform, en dat verschil is de reden dat
`TokenOpslag` een interface is. Op web staat het in een httpOnly-cookie die de server zet: de
client ziet hem nooit en kan hem dus ook niet lekken via een XSS-fout. De webimplementatie
bewaart daarom niets en geeft `null` terug — verversen gebeurt door het endpoint aan te roepen
met `withCredentials`. Op native bestaan geen httpOnly-cookies, dus komt het opake token in
Keychain of Keystore; die klasse **werpt** nu nog, in plaats van stilletjes op `localStorage`
terug te vallen. Er is een test die vastlegt dat `localStorage` en `sessionStorage` niet
worden aangeraakt.

### Eén verversing tegelijk

Bij het herladen van een scherm lopen meerdere verzoeken tegelijk. Krijgen die allemaal een
401 en gaan ze allemaal zelfstandig verversen, dan wisselt elk van hen het refresh-token in —
en het tweede gebruik van een al ingewisseld token is precies wat de server als **diefstal**
aanmerkt (§7.6, F06b): die trekt dan de hele tokenfamilie in en logt de gebruiker overal uit.
Een normale herlaadactie zou de gebruiker dus uitloggen.

`EnkeleVerversing` zorgt dat er hoogstens één verversing loopt; de rest wacht op dezelfde
belofte. Losstaand van Angular gehouden en getest met acht gelijktijdige aanroepen: één
inwisseling. De interceptor herhaalt daarna hoogstens één keer — een tweede 401 met een verse
token is een rechtenprobleem, en dat los je niet op door harder te proberen. De auth-endpoints
zelf zijn uitgesloten: verversen op `/auth/verversen` is een oneindige lus.

### Overig

Foutafhandeling vertaalt naar één vorm `{ code, melding, referentie, status }` en verzint
nooit detail dat de server niet gaf; bij een 500 met een HTML-foutpagina toont de client een
korte tekst en niet de inhoud. De beheerschil is een aparte route, en de handelingen die daar
komen worden server-side geweigerd op een token met `client: 'native'` (§7.8, test 36) — de
client dwingt dat niet zelf af.

De ESLint-uitzondering op `no-extraneous-class` geldt nu ook voor `apps/app`: Angular-
componenten hebben net als NestJS-modules een lege body met alleen decorators.

---

## V01 — VvE-beheer door de applicatiebeheerder

### Wachtwoord wordt ingetypt, niet gemaild

De spec (§3.3) laat de applicatiebeheerder een wachtwoord _genereren en mailen_, of liever nog
een eenmalige instellink sturen. Geen van beide kan zolang SMTP hier onbruikbaar is door
antispam-maatregelen. Daarom typt de applicatiebeheerder het wachtwoord zélf in — er staat een
knop naast die er een uit de CSPRNG van de server laat voorstellen — en geeft hij het buiten de
applicatie om door.

Wat hierbij **niet** verandert: er wordt nog steeds nergens een wachtwoord in platte tekst
bewaard. Alleen de argon2id-hash gaat de database in. De applicatiebeheerder kent het
wachtwoord doordat hij het zelf koos, niet doordat het systeem het onthoudt. Een bestaand
wachtwoord is dus ook niet op te vragen; het scherm toont een nieuw wachtwoord daarom één keer,
met de waarschuwing erbij, en daarna nooit meer.

De gemailde variant is niet weggegooid maar uitgesteld: `auth.uitnodiging_methode` uit §3.3
blijft de plek waar dat straks aangezet wordt.

### `wachtwoord_verloopt_op` blijft leeg

§3.3 zet die op `now + 14 dagen`. Er is nog geen scherm om een wachtwoord te wijzigen, dus die
datum zou een tijdbom zijn: zodra de controle erop gebouwd wordt, is elk account dat nu wordt
aangemaakt in één klap onbruikbaar. `wachtwoord_wijzigen_verplicht` staat wél aan — dat is de
vlag waar dat scherm straks op aanslaat, en die sluit niemand buiten.

### Geen TenantGuard op deze module

De `TenantGuard` eist een `vve_id` in het token. De applicatiebeheerder werkt juist over alle
VvE's heen en heeft er zelf geen, dus zou elke route 403 geven. De afscherming is daarom
expliciet: `SessieGuard` voor de authenticatie, plus een controle op
`persoon.is_applicatiebeheerder` in elke handler.

### Foutvorm van de API (raakt de hele applicatie)

De client documenteerde `{ code, melding, referentie }`, maar de API stuurde de standaardvorm
van Nest (`{ statusCode, error, message }`) en had helemaal geen exception filter. Daardoor
matchte er niets en viel élke serverfout terug op de generieke tekst bij de statuscode — bij een
fout wachtwoord uitgerekend "U bent niet (meer) ingelogd.", wat als een sessieprobleem leest.
`HttpFoutFilter` zet dit recht: 4xx geeft de (door onszelf geschreven, bewust nietszeggende)
tekst van de server, 5xx geeft alleen een referentie en logt de rest server-side.

### Enter in een Ionic-formulier

De submit-knop van een `<ion-button type="submit">` zit in de shadow DOM en telt niet mee voor
de impliciete submit van de browser. Bij twee of meer velden deed Enter daardoor niets, terwijl
klikken wél werkte (Ionic geeft die klik zelf door). Elk formulier krijgt nu een verborgen
native submit-knop.

### `bootstrap()` alleen bij een echt startpunt

`main.ts` riep `bootstrap()` aan bij het laden van het bestand. De guard-test importeert dat
bestand om `ALLE_CONTROLLERS` te lezen en startte daarmee een echte server, die vastliep op een
ontbrekende `DATABASE_URL`. De aanroep staat nu achter een controle op `process.argv[1]`,
hetzelfde patroon als in `database/seeds/beheerder.ts`.

## Ontwikkelgereedschap — schema opnieuw opbouwen (11-09-2026)

### Waarom naast "alleen voorwaarts" een herbouwknop staat

De migratierunner weigert te draaien zodra een reeds toegepaste migratie is bewerkt (F03,
punt 3 hierboven). Dat is de juiste regel zodra er data in staat die niemand kwijt wil,
maar zolang het datamodel zelf nog beweegt kost elke correctie op een bestaande tabel een
extra migratiebestand — en groeit de reeks vol met reparaties van reparaties. Daarom nu
een tweede modus voor de ontwikkelfase: `npm run db:opnieuw --workspace @vve/api` gooit
`public` weg en draait alle migraties opnieuw. De alleen-voorwaarts-regel blijft
ongewijzigd; hij geldt alleen niet meer voor een database die je elke keer weggooit.

Toegevoegd: `db:opnieuw` (herbouw) en `db:opnieuw:seed` (herbouw plus het
applicatiebeheerdersaccount, wachtwoord één keer op het scherm).

### De wachter kijkt naar de host, niet naar NODE_ENV

Eerst overwogen: weigeren bij `NODE_ENV=production`. Dat blijkt in dit project een
valstrik. `.env.voorbeeld` zet `NODE_ENV=production` — het sjabloon is voor de VPS
geschreven — dus elke ontwikkelmachine die dat bestand kopieert draagt dat label zonder
dat er iets productie-achtigs aan is. Een wachter die in de normale werkgang elke keer ten
onrechte afgaat, leert je hem te omzeilen; dan is hij minder waard dan geen wachter.

Nu is de harde grens de host uit `DATABASE_URL`: alleen `localhost`, `127.0.0.1` en `::1`.
`NODE_ENV=production` levert nog wel een waarschuwing met de suggestie om lokaal
`NODE_ENV=development` te zetten. Bekende ontsnapping, bewust niet afgedekt: een
SSH-tunnel maakt een productiedatabase ook bereikbaar op 127.0.0.1.

### `public` wordt teruggezet zoals PostgreSQL hem zelf aanlegt

Niet `CREATE SCHEMA public` (eigenaar wordt dan de verbindende gebruiker), maar
`AUTHORIZATION pg_database_owner` plus `GRANT USAGE ... TO PUBLIC` — de vorm die
PostgreSQL 15+ bij een verse database gebruikt, waarin PUBLIC juist géén CREATE meer
heeft. Anders staat de lokale database ruimer open dan een verse installatie en test je
iets anders dan wat er in productie draait. Nagemeten: na herbouw zijn tabellen, policies
en RLS-vlaggen identiek aan de database die via de gewone migratieweg is opgebouwd.

De rollen `vve_app`/`vve_migratie`/`vve_platform` overleven de herbouw — rollen zijn
cluster-breed, niet schema-gebonden — en migratie 0003 maakt ze aan achter een
bestaanscontrole, dus een tweede herbouw struikelt er niet over. De extensies staan wél in
`public` en verdwijnen mee; 0001 zet ze terug.

### De runner wordt aangeroepen, niet geïmporteerd

`opnieuw-opbouwen.ts` start `run-migraties.ts` als kindproces. Een directe import zou
netter ogen, maar kan hier niet: Node's type-stripping lost een `.js`-specifier niet op
naar het `.ts`-bestand ernaast (nagemeten op v22.23), terwijl `tsc` met NodeNext juist die
`.js`-specifier eist — een directe import breekt dus óf de build óf het draaien vanuit
`src`. En vanuit `src` draaien is hier het punt: dan lees je altijd de `.sql`-bestanden
zoals ze nu op schijf staan, nooit een verouderde `dist`. Om dezelfde reden draait
`db:opnieuw:seed` het seed-script wél uit `dist` (dat importeert de wachtwoordmodules met
`.js`-specifiers en moet dus gecompileerd zijn) — vandaar de `npm run build` die daar al in
zat.

### `db:migrate:dist` verwijderd

Dit script (F03, punt 5) draaide de runner uit `dist`, maar `tsc` kopieert de
`.sql`-bestanden niet mee: lokaal faalde het altijd met ENOENT. In de image bestaat het
probleem niet — `infra/api.Dockerfile` kopieert de migratiemap expliciet naar
`dist/src/database/migraties` — en dáár luidt het advies al `node
apps/api/dist/src/database/run-migraties.js`. Het script werkte dus alleen in de omgeving
waar niemand het gebruikte. Weg; de Dockerfile bleef ongewijzigd.

### Scripts lezen nu zelf `.env`

`db:migrate`, `db:opnieuw` en `seed:beheerder` krijgen `--env-file-if-exists=../../.env`,
zodat `DATABASE_URL` niet elke keer met de hand voor het commando hoeft. Een variabele die
al in de omgeving staat wint van het bestand (nagemeten), dus CI en de tests houden hun
eigen `DATABASE_URL`. `-if-exists` omdat `.env` buiten git staat en dus niet overal is.

## V01 — Startscherm per rol (11-09-2026)

### De fout

Iedereen kwam na het inloggen op `/portaal` uit, en daar stond een knop `VvE-beheer` die
voor alle rollen zichtbaar was. `/beheer` is het scherm waar VvE's worden opgevoerd en
beheerderswachtwoorden worden uitgereikt — voorbehouden aan de applicatiebeheerder
(AC1.1, AC1.3). Een VvE-beheerder belandde zo in een opvoerformulier waar hij niets mag.

De API weigerde die handelingen al met 403 (`#eisApplicatiebeheerder` staat op elke
VvE-route), dus er lekte niets. Maar een knop die voor iedereen zichtbaar is en voor bijna
niemand werkt, is een foutmelding vermomd als functionaliteit: de gebruiker leert er alleen
uit dat de applicatie stuk lijkt.

### Rollen komen uit een endpoint, niet uit het token

De client kon de rol niet weten: het access-token draagt alleen `sub`, een optionele
`vve_id` en de MFA-markering. Nieuw endpoint `GET /api/auth/mij` met wie je bent,
of je applicatiebeheerder bent, en de VvE's waarin je een lopende rol hebt.

Bewust geen rolclaim in het token erbij. Rollen in een token zijn de rollen van het moment
van uitgifte; een beheerder die zojuist is ontheven, zou met zijn lopende token nog een
beheerscherm openen. Een endpoint is per definitie vers. Alleen lopende rollen tellen mee
(`eind_datum is null`) — een beëindigde rol hoort geen startscherm op te leveren.

### De keuze staat op één plek, als pure functie

`startRoute()` in `apps/app/src/app/kern/start-route.ts`: applicatiebeheerder naar
`/beheer`, wie een lopende VvE-rol heeft naar `/vve`, de rest naar `/portaal`. Geen
Angular eromheen, want het is een regel en geen schermdetail — zo staat hij in `kern.spec.ts`
met zes gevallen, inclusief de combinatie applicatiebeheerder-én-VvE-rol (beheer wint) en
de beheerder van een gearchiveerde VvE (naar zijn overzicht, waar staat waarom hij niets kan).

Dit stuurt alleen de navigatie en autoriseert niets. De guards `vereistApplicatiebeheerder`
en `vereistVveRol` houden dezelfde regel aan bij directe navigatie; de 403 op de server
blijft het vangnet. Dat is met opzet dubbel: de client beslist waar je heen gaat, de server
beslist wat je mag.

### Het overzichtscherm toont wat er is, niet wat er hoort te zijn

§9 wil op het startscherm van de beheerder een actielijst: openstaande posten boven een
drempel, ongematchte banktransacties, verlopende polissen, ALV zonder notulen. Geen van die
gegevens bestaat nu — eenheden komen in V02, de financiële blokken daarna. `/vve` toont
daarom de VvE zelf (naam, plaats, boekjaar, status, de eigen rol) en zegt er in één zin bij
wat nog volgt. Liever dat dan tegels met nullen, die de indruk wekken dat er niets aan de
hand is terwijl er niets gemeten is.

### Wortelroute beslist, in plaats van vast door te sturen

`''` stuurde hard door naar `portaal`. Nu hangt er een guard onder die hetzelfde
`startRoute()` gebruikt, zodat er geen tweede plek is waar de startkeuze wordt gemaakt.
Bij een harde herlaad komt iedereen op het inlogscherm: het access-token staat alleen in
het geheugen (§7.6) en er is nog geen stille verversing bij het opstarten. Dat is bestaand
F11-gedrag en niet in dit blok veranderd.

### Stille verversing bij het opstarten (11-09-2026)

Na een herlaad kwam iedereen op het inlogscherm terwijl er een geldige sessie lag: het
access-token staat alleen in het geheugen (§7.6, en dat blijft zo — alles wat JavaScript
kan lezen, kan een XSS-fout ook lezen), terwijl het refresh-token in zijn httpOnly-cookie
de herlaad wél overleeft. Er werd alleen nooit iets met die cookie gedaan vóór de eerste
navigatie.

Nu doet `provideAppInitializer` in `main.ts` één verversronde vóórdat de router zijn eerste
route bepaalt. Lukt het, dan haalt hij ook meteen het profiel op en komt de gebruiker terug
op de pagina die hij herlaadde. Lukt het niet, dan blijft hij uitgelogd en klopt het
inlogscherm.

**Eén poort voor alle verversingen.** De interceptor had zijn eigen `EnkeleVerversing` als
module-variabele. Met een tweede verversingspad erbij zouden dat twee onafhankelijke
sloten zijn geweest, en twee sloten is geen slot: twee gelijktijdige inwisselingen van
hetzelfde refresh-token zijn voor de server niet van diefstal te onderscheiden en kosten de
gebruiker al zijn sessies. De poort staat daarom nu in `AuthService` (`verversEenmalig()`),
waar beide paden langsgaan. In de browser nagemeten: een herlaad levert precies één
`POST /auth/verversen` op.

**Een tijdslimiet van 8 seconden.** Deze stap blokkeert het opstarten, dus een server die
niet antwoordt zou een wit scherm opleveren. `metTijdslimiet` geeft het na 8 seconden op en
levert het inlogscherm. Een antwoord dat daarna alsnog binnenkomt, richt geen schade aan:
de rotatie is dan al door de browser verwerkt en de eerstvolgende 401 ververst gewoon
opnieuw. Een fout telt daarbij als "niet gelukt", ook omdat een late afwijzing anders als
unhandled rejection zou blijven liggen — daar staat een test op.

**Uitloggen blijft uitloggen.** Nagemeten dat een herlaad ná uitloggen op het inlogscherm
uitkomt: `uitloggen` wist de cookie, dus er valt niets te herstellen. Een opstartherstel dat
een net beëindigde sessie weer tot leven wekt, zou erger zijn dan het probleem dat het
oplost.

---

## V02 — Wooneenheden (11-09-2026)

**Eerste tenant-scoped blok: de F08-guards zijn nu bedraad.** V02 maakte de
eerste routes waarop de volledige §7.5-keten (SessieGuard → TenantSessieGuard →
RolSessieGuard) staat. Eerder blokkeerde die keten alleen op papier: de
`TenantGuard` eist een `vve_id`-claim in het access-token, maar
`tekenAccessToken` zette er nooit één. Dat is nu geplugged:

**De actieve VvE woont op de sessie-rij (migratie 0011).** Kolom
`apparaat_sessie.actieve_vve_id`, gezet via het nieuwe
`POST /auth/actieve-vve`. De service controleert daar een lopende
`rol_toewijzing` tegen de database van het moment — de keuze van de tenant is
geen client-meningsuiting (§7.5 stap 2). Het antwoord is een vers access-token
mét claim; het refresh-token verandert niet, en elke rotatie erft de claim van
de sessie-rij, zodat de tenant overleeft. De client kiest de VvE via
`AuthService.kiesActieveVve` (voorlopig de eerste uit het profiel; een echte
VvE-wissel in de UI volgt later).

**`wooneenheid.gebouw_id` verwijst alleen naar gebouw(id), zoals de
spec-letter.** Dat het gebouw bij dezelfde VvE hoort als zijn eenheden, is niet
met een gewone FK te bewaken — een FK omzeilt RLS. De service zoekt of maakt
het gebouw daarom binnen de tenant-transactie, waar RLS al bewijst dat de
gevonden rij bij deze tenant hoort.

**EXCLUDE-constraints vragen `btree_gist`.** Migratie 0010 maakt de extensie
aan vóór de gist-constraints (`geen_dubbel_volledig_eigendom`, geen overlap per
eenheid+persoon, geen lege periode). Zonder de extensie faalt het DDL met
"no default operator class for access method gist".

**AC2.3 is een waarschuwing, geen blokkade.** De lijst retourneert
`somTeller`, `noemer` en `verschil`; de client toont het verschil in geel en
werkt gewoon door. Een VvE die nog niet alle eenheden heeft ingevoerd mag niet
worden tegengehouden.

**Eén eigenaar per eenheid voorlopig.** `eigenaarschap` heeft al
`aandeel_promille`, `is_primair_contact` en de `daterange`-historie, maar het
scherm koppelt per aanmaak precies één eigenaar (de beheerder zelf, AC2.1).
Meerdere eigenaren, aandelen 50/50 en de eigenaarswissel met
verrekenoverzicht zijn blok V03; V04 voegt de uitnodigingsflow toe (AC2.2).

---

## V04 — Uitnodigingen (11-09-2026)

**De registratielink wint van het gemailde wachtwoord (§3.3-aanbevolen
variant).** Per nieuw adres ontstaat een rij in `uitnodiging` (migratie 0012,
exact de spec-tabel) met een opak token: 32 bytes CSPRNG, alleen de sha256-hex
in de database — het patroon van `refresh_token_hash`. De mail met de link is
`gevoelig` (F10): de tekst met de link wordt na verzending gewist, de regel
blijft als verzendbewijs. In de tests bewezen met de echte wachtrij.

**Bestaand persoon → geen token.** Is het adres al persoon (eigenaar in een
andere VvE), dan wordt hij in de tenant-transactie direct gekoppeld als
eigenaar en ontvangt alleen de "u bent toegevoegd aan VvE X"-mail (§3.3 stap
2). Geen registratie-omweg voor iemand die al een account heeft.

**Registratie staat buiten de tenant-guards — bewust.** Wie registreert heeft
nog geen account; het ééndegligige opake token ís de autorisatie. De
service consumeert het token in dezelfde transactie als de accountaanmaak
(gebruikt_op + wachtwoord-hash + rol_toewijzing + eigenaarschap), zodat een
dubbelaangeboden token de tweede keer hard faalt. Het registratie-endpoint
verkondigt onbekend/verlopen/gebruikt met één uniforme melding.

**Het ruwe token gaat niet naar de beheerder.** Het antwoord van de
uitnodiging-endpoints noemt alleen status en id; het token verlaat de service
uitsluitend richting mailwachtrij. De beheerder hoeft het nooit te zien — de
link hoort in de mailbox van de ontvanger, nergens anders.

**SMTP is nog een stub.** De verzender schrijft één logregel; de wachtrij,
backoff en het gevoelig-wissen zijn al het echte F10-pad. Bij de livegang
wordt alleen de verzender vervangen — de service en de wachtrij veranderen
niet. Tests injecteren een eigen verzender.

**Wat op V03 wacht.** De eerste koppeling zet `is_primair_contact` en
`aandeel_promille = 1000`; meerdere eigenaren per eenheid, aandeelverdeling
(50/50) en de eigenaarswissel met verrekenoverzicht zijn V03. Bewoner-
uitnodigingen (rol `bewoner`, AC2.6) maken de rij en het token al, maar de
bewonersrechten volgen in een later blok.

---

## G01 — Grootboekrekeningen (11-09-2026)

**Het §5.7-schema is 37 rekeningen, exact geteld: 11 balans (3 eigen vermogen,
5 activa, 3 passiva) + 20 lasten + 6 baten.** De dotatie-paring `4950`
(dotatie reservefonds, last) en `8150` (voorschotbijdragen reservefonds, baten)
zitten erin, met `is_reservefonds = true` op `0600` (balans) en `1150`
(bankreserve) — de twee vlaggen waar de saldocontrole van §5.4 straks op
aangrijpt. De test bewaakt de telling per categorie, zodat een latere
wijziging van het schema niet stil kan inslippen.

**Bij het aanmaken van een VvE zit de kopie in dezelfde transactie (AC9.1).**
De vve-service stopt de 37 rekeningen in hetzelfde atomare aanmaakmoment —
een VvE bestaat vanaf geboorte mét zijn rekeningplan. De aparte
`kopieerStandaardSchema`-service is er voor bestaande VvE's (idempotent:
nummers die er al staan worden overgeslagen), bv. bij het bijwerken van het
standaardschema zelf.

**Verwijderen is geen operatie.** Rekeningen deactiveren kan, verwijderen
niet: G02's append-only boekingen hangen straks aan deze id's en de nummers
zijn het anker van het auditverleden. De kolom `verdeelsleutel_id` uit §6.7
komt mee in de migratie van G03 (de FK-target-tabel bestaat nog niet).

**Kolom `aangemaakt_op` bewust weggehaald bij deze tabel.** De spec-tabel
heeft hem niet (alleen de algemene §6-conventie noemt hem); het DDL van de
migratie is leidend en het Drizzle-schema volgt exact — anders valt elke
insert over een kolom die niet bestaat.

---

## G02 — Boekjaar en boekingsservice (11-09-2026)

**Twee vangnetten op de balanseis, zoals §7.4 voorschrijft ("beide moeten
bestaan").** Vangnet 1: de boekingsservice weegt debet/credit vóór het
schrijven en gooit `OnbalansFout`. Vangnet 2: migratie 0014 zet een
`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` op `boeking` die bij
COMMIT per boeking `sum(debet) = sum(credit)` controleert — het vangnet voor
de directe-insert-omweg. In de test bewezen: een ongebalanceerde rechtstreekse
insert slaagt totdat de transactie commit, en faalt dan hard. (Bij een
vacuüm-boeking zónder regels is 0 = 0 en slaagt de trigger terecht; de
test insert daarom een boeking mét een enkelvoudige debetregel.)

**Append-only via REVOKE, niet via RULE.** Migratie 0014 ontneemt vve_app
UPDATE/DELETE op `boeking` en `boekingsregel`. Een `CREATE RULE ... DO
INSTEAD NOTHING` zou de UPDATE stilzwijgend laten slagen (slecht: de caller
denkt dat het gelukt is); de REVOKE laat hem hoorbaar falen. De
vergrendelings-UPDATE van AC9.3 (`boeking.vergrendeld`) wacht op de
expliciet gerechtigde routine van B10 — de status 'afgesloten' blokkeert
via de boekingsservice al elke nieuwe boeking.

**Foutklassen éénmalig gedefinieerd.** `boekjaar-service.ts` hergebruikt
`InvoerFout`/`NietGevondenFout` uit `boekhouding.ts` in plaats van een
eigen kopie: twee klassen met dezelfde naam zijn voor `instanceof` twee
verschillende dingen, en de controller (én de tests) toetsen over beide
services heen.

**RLS op `boekingsregel` via EXISTS op de moeder-boeking.** De regeltabel
heeft geen eigen `vve_id` in de spec; de policy volgt de koppeling
(`boekingsregel.boeking_id → boeking.vve_id = app.vve_id`). Kosten: één
subquery per rijcheck; winst: het patroon van §6.9 blijft letterlijk.

**`@vve/domein` is nu een echte projectreferentie van `apps/api`.** F01
hield het domeinpakket bewust buiten de referentielijst zolang niemand hem
aanklaste; de boekingsservice is de eerste echte gebruiker (`Bedrag` in
centen, met de ESLint-wachters van F05/F12 op de velden). `SystemKlok`
definieert zijn eigen `Klok`-vorm bewust verder — die dubbele definitie is
de volgorde van de migraties naar één definitie, maar G02 begon met de
referentie.

**Boekingsnummering: `2026-000001`, per jaar oplopend via count(\*).** De
UNIQUE (vve_id, nummer) vangt gelijktijdigheid af: bij een race slaagt er
één en faalt de andere hoorbaar. Voor de nota-generatie (G06) met batchen
komt dan een echte `FOR UPDATE`-nummerreeks — zie de spec-regel voor G06.

---

## G03 — Verdeelsleutels (11-09-2026)

**Gewichten van de afgeleide typen worden niet opgeslagen, maar live gerekend.**
Bij `breukdeel` is het gewicht de teller van de eenheid, bij `vierkante_meters`
de oppervlakte, bij `gelijke_delen` 1, bij `stemmen` het aantal stemmen —
uit de eenhedentabel op het moment van verdeling. Alleen `handmatig` slaat
gewichten op in `verdeelsleutel_regel` (AC4.2). Reden: opgeslagen kopieën van
tellers en m² raken vanzelf uit de pas met de eenhedenlijst; live lezen is
altijd actueel en de verdeling is reproduceerbaar (de §5.2-verdeler sorteert
op eenheid-id, niet op invoegvolgorde).

**Uitsluiting (AC4.2) per type.** Handmatig: regel met gewicht 0. De
afgeleide typen sluiten impliciet uit: een eenheid zonder teller/m²/stemmen
(0 of NULL) doet niet mee en het totaal wordt over het restant verdeeld.
Een uitsluitingslijst als aparte tabel is bewust niet gebouwd — de gewicht-0
route dekt de use-case met één mechanisme.

**Historisering (AC4.5) met id-stabiliteit.** `nieuweVersie` maakt een nieuwe
rij met versie+1 (op de naam gezocht, zodat meerdere versies van één sleutel
oplopen) en kopieert de regels als de aanroeper ze niet zelf opgeeft; de
oude rij gaat op `actief = false` en blijft met zijn regels bereikbaar.
Nota's die naar de oude id verwijzen (G06) blijven bewust op de oude versie.

**De `grootboekrekening.verdeelsleutel_id`-FK uit §6.7 is gelegd** in
migratie 0015 — G01 had hem overgelaten omdat de FK-target-tabel nog niet
bestond. Optioneel: een rekening kan zónder default-sleutel.

**Verdeling zelf is de F05-kern, niet dubbel gebouwd.** De service leest de
gewichten in de tenant-transactie en roept `grootsteRestVerdeler` aan
(grootste-restmethode, bewezen in tests 1–4 en differentieel getoetst).
`voorbeeldVerdeling` (AC4.4) levert per eenheid het bedrag en toetst
onverdeeld = 0 als extra toets op de somgarantie.

---

## G04 — Begroting (11-09-2026)

**Statusflow bewaakt in de service, niet alleen in de UI (AC5.1).**
`concept → voorgesteld_alv → vastgesteld → gesloten`, met een toegestane-
overgangen-tabel: regels wijzigen kan alleen in concept (anders stemt de ALV
over iets anders dan het scherm toonde), vaststellen alleen vanuit
voorgesteld_alv, en gesloten is het eindpunt. Vaststellen zet
`vastgesteld_op` op vandaag. G06's nota-generatie eist later 'vastgesteld'.

**De vorig-jaar-kolom (AC5.7) leest uit de boekingen, niet uit een kopie.**
De vergelijking somt per grootboekrekening de regels van het vorige
boekjaar (append-only, G02); de richting volgt de categorie — lasten/activa
tellen debet−credit, baten/passiva credit−debet. Er is dus geen aparte
"realisatie"-tabel nodig: de boeking zelf is de realisatie.

**AC5.7-PDF bewust als datastructuur geleverd.** Het detail-endpoint
retourneert de volledige ALV-tabel (regels, exploitatie/reserve-totalen,
vergelijking) als JSON. De PDF zelf volgt bij de verzend-flow (G07/G13);
de spec-eis is de export en zijn kolommen — die structuur is hier al
exact zo vastgelegd.

**`besluit_id`-kolom is er, de FK volgt later.** Het besluitenregister is
blok A03; de kolom bestaat in de migratie zonder FK zodat het DDL geen
verwijzing naar een niet-bestaande tabel aanraakt.

**Seed-realisatie in tests rechtstreeks geïnserte rijen.** De
boekingsservice weigert boeken in een afgesloten jaar terecht; de
vorig-jaar-historie is er simpelweg, dus de test insert een gebalanceerde
boeking direct (waar de deferred trigger bij COMMIT over toeziet).

---

## B01 — IBAN-versleuteling (11-09-2026)

**Het §6.2-drieluik als één crypto-module (`bank/iban-versleuteling.ts`).**
AES-256-GCM met een willekeurige 12-byte nonce per versleuteling
(nonce ‖ ciphertext ‖ tag, precies de spec-vorm); een vaste IV is met
GCM-hergebruik van nonce de ernstigste mogelijke fout en F12 bewaakt hem.
HMAC-SHA256 over het genormaliseerde IBAN met een aparte zoeksleutel:
deterministisch en indexeerbaar, zodat de matchingmotor (B05) koppelt
zonder ooit te ontsleutelen. Twee aparte sleutels uit de omgeving
(`IBAN_VERSLEUTEL_SLEUTEL`, `IBAN_HMAC_SLEUTEL`, minimaal 32 bytes, geen
standaardwaarde — §8.2).

**Normalisatie vóór de HMAC.** Spaties/streepjes eruit, hoofdletters:
`nl91 abna 0417 1643 00` en `NL91ABNA0417164300` matchen op dezelfde HMAC.
Zonder deze stap is de zoeksleutel waardeloos, want banken groeperen
allerlei. De mod-97-toets (checksum) weigert verzonnen IBAN's vóór het
versleutelen.

**`sleutel_versie` op de rij, rotatietaak nog open.** De kolom staat en de
module levert `HUIDIGE_SLEUTEL_VERSIE = 1`; de achtergrondtaak die rijen
naar een nieuwe versie hersleutelt is het resterende deel van B01 en volgt
met de bankimport (B02), die dezelfde sleutel nodig heeft voor de ruwe
importbestanden in `/storage/import`.

**Tabel `sepa_machtiging` is de eerste met het drieluik.** Exact de
spec-tabel (§6.5), inclusief de vorig-kenmerk/vorig-iban-velden voor de
mandaatwijziging (AC8.8) en de storno-teller (AC8.7) — die kolommen staan
klaar voor I01/I06. Gebruikers van de kolommen gaan door de module:
`beveiligIban` vult, `ontsleutelIban` leest, niemand raakt de bytea's
rechtstreeks. Index op `iban_hmac` bewijst in de test dat een zoekactie de
rij vindt zonder te ontsleutelen.

---

## G05 — Bijdrageschema (11-09-2026)

**Drie methoden, één uitkomstvorm (§5.3).** `uit_begroting` verdeelt elke
begrotingsregel via de G03-sleutel (gewichten live, §5.2-verdeler) en houdt
exploitatie en reserve apart over de `is_reservefonds`-vlag van de regel.
`vierkante_meters` is factelijk methode 1 met één regel (totaal ÷ totaal
m² × m²), via dezelfde verdeler met m² als gewicht. `vast_bedrag` neemt
handmatige periodebedragen en leidt het jaarbedrag daaruit af.

**De periodeverdeling is bewust bij G06.** Het schema bewaart het
_jaarbedrag_ per eenheid; de tweede verdeling van §5.3 (jaarbedrag → N
perioden, grootste-rest, centen in de eerste maanden) gebeurt bij de
nota-generatie, waar de periodiciteit en de ingangsdatum van de periode
bekend zijn. Hier is dat een keuze met een reden: het schema kan vóór
vaststelling herberekend worden (proefverdeling op het scherm, AC5.3) —
periodedelen opslaan zou die proef telkens herschrijven terwijl G06 de
verdeling deterministisch zelf aanbrengt bij elke nota.

**Dekkingsanalyse (AC5.2) via het Bedrag-waardetype.** De F12-wachter
verbiedt ruwe centenrekenkunde; het dekkingsverschil rekent met
`Bedrag.min`. Positief verschil = dekkingstekort (de "dekkingstekort €
1.240"-tekst uit de spec is hier de centwaarde), negatief = overschot.

**Test #7-kern bewezen op schemaniveau.** Een drastisch gewijzigde
breukdeelteller verandert de opgeslagen regels van het schema niet: de
regels zijn het bewijs van de berekening op het moment van herbereken.
Nota's (G06) verlaten op datzelfde principe op bedragniveau.

**Statusflow en bewaking.** Het schema deelt de begrotings-status-enum;
herberekenen en vaste bedragen wijzigen kan alleen in `concept`. De status-
schuif volgt in G06 samen met de nota-generatie, die 'vastgesteld' eist.

---

## G06 — Nota-generatie (11-09-2026)

**Nummerreeks met FOR UPDATE op de boekjaar-rij (test #10).** Eerste poging
zette `FOR UPDATE` op de count-over-nota — Postgres weigert dat (0A000,
CheckSelectLocking). De lock staat nu op de moeder-rij: alle gelijktijdige
generaties voor één boekjaar serialiseren op die rijvergrendeling, daarna is
de telling stabiel. `UNIQUE (vve_id, nummer)` vangt hard af wat er nog
doorheen glipt. Getest met 15 gelijktijdige generaties: exact 2 nota's,
nummers 0001/0002, geen dubbele.

**Idempotentie ná de vergrendeling.** De periode-toets (zelfde type/boekjaar/
van/tot → 0 nota's) moet ná de `FOR UPDATE` lezen, niet ervoor — anders
lopen parallelle generaties er allebei doorheen vóór de eerste COMMIT en
ontstaan alsnog dubbele periode-nota's. Deze volgorde is de kern van test
#10, niet de nummering zelf.

**Tweede verdeling van §5.3 op de juiste plek.** Het bijdrageschema bewaart
jaarbedragen; de nota-verdeling verdeelt het _componentgewijs_ — exploitatie
en reserve elk apart over N perioden met de grootste-restmethode. Daardoor
krijgt index 0 in elk component het restcent (16.667+16.667+8.334+8.334 +
4×8.334 = 83.338 bij de test-inkomst). Verwachtingen in de test zijn tegen
een exacte referentie nagerekend (Python-referentie in de sessie).

**Betalingskenmerk (AC6.2).** `NOTA{nummer}` op elke nota; `UNIQUE (vve_id,
betalingskenmerk)` afgedwongen. Het afletteren zelf (B05, AC7.4-stap 1)
zoekt dit kenmerk in de bankomschrijving; de nota-dienst geeft de
betalingswijze default 'overboeking', incasso (AC8.3) zet 'incasso' in M8.

**Restcent-berekening is bewust per component.** Het restcent van de
exploitatieverdeling en dat van de reserve verhouden zich tot hun eigen
totalen, niet tot de combinatie — dit sluit aan bij de aparte §5.3-
verdelingen van G05 en houdt de exploitatie/reserve-splitsing exact.

---

## G07 — Nota-PDF en verzending (11-09-2026)

**PDF in de database, niet op het bestandssysteem.** `pdf_document` bewaart
de bytes (bytea, migratie 0020); AC13.5 ("inclusief het verzonden
PDF-bestand — bewijslast bij aanmaningen") hoort bij het dossier. De nota
koppelt via het bestaande `pdf_document_id` uit 0019.

**Dependency-vrije PDF (nota-pdf.ts).** Een minimale PDF 1.4-schrijver:
één A4-pagina, base-14-fonts (Helvetica/Bold), WinAnsi. De spec-eis is een
leesbaar bewijsstuk met nummer, kenmerk, specificatie exploitatie/reserve,
vervaldatum — geen typografie. Tekens buiten WinAnsi vallen bewust weg naar
'?' (inhoud exact, tekenset beperkt). De xref-tabel wordt handmatig
opgebouwd; de test leest de bytes terug en controleert %PDF-kop, %%EOF,
kenmerk en totalen in de inhoudsstroom.

**Postlijst via communicatie_wijze, niet via een lege e-mail.** Eerste
aanpak (e-mail `''` bij persoon) botste tegen de UNIQUE-constraint op citext
— en was sowieso het verkeerde veld. Het datamodel heeft al
`communicatie_wijze` ('email'/'post'/'beide', migratie 0001): de
verzend-service behandelt `communicatie_wijze = 'post'` als AC13.4-postlijst.
De test seedt twee eigenaren, één met 'post'.

**Geen dubbelt op drie niveaus.** (1) `verzonden_op` op de nota bewaakt de
serie (tweede run = 0 verzendingen, getest); (2) de F10-wachtrij-claim
(§7.7) voorkomt dubbelt per bericht; (3) auditlog noteert elke
serie-verzending. De PDF wordt bij verzending _vers_ gebouwd en bewaard —
het bewijs hoort bij het verzendmoment, niet bij een oude concept-PDF.

---

## G08 — Betalingen (11-09-2026)

**Append-only geldstroom in.** `betaling` + `betaling_koppeling` (migratie
0021, exact §6.6); corrigeren gebeurt met een tegengestelde betaling (bron
'verrekening'), nooit met UPDATE/DELETE. `betaling_bron` bestond al in 0001
(§6.1-hoofdlijst) — dubbele CREATE TYPE leverde de eerste testrun 22
rode suites op; geleerd: vóór een migratie de §6.1-enumlijst nakijken.

**Openstaand_cent is afgeleid.** De nota-tabel bewaart openstaand/status,
maar beide worden per koppeling herberekend in dezelfde transactie
(gekoppeld-som via subquery, FOR UPDATE op de notarij in id-volgorde tegen
deadlocks). Overkoppeling (meer koppelen dan openstaat) wordt geweigerd en
laat de nota onveranderd — getest.

**Creditsaldo (test #9) is de kern van de automatische verwerking.** De
som van betaald-maar-niet-gekoppeld per eenheid is het creditsaldo; bij het
_genereren_ van een nieuwe nota (G06) verrekent de nota-service dat saldo
automatisch: een betaling met bron 'verrekening' + koppeling in dezelfde
transactie, nota-status bijgewerkt. Het saldo is live gerekend (SUM over
betalingen − SUM over koppelingen), nooit opgeslagen — opgeslagen saldi
raken uit de pas met append-only correcties.

**Drie gevallen (AC6.3) getest:** #8 deelbetaling → deels_betaald met
restant; volledig → betaald met 0, ook over meerdere nota's in één
betaling; #9 vooruitbetaling → creditsaldo → automatische verwerking met de
februari-nota (bron 'verrekening' zichtbaar in de betalingslijst).

---

## G09 — Debiteurenoverzicht (11-09-2026)

**Lees-only venster op G06/G08.** Geen nieuwe tabellen: de analyse telt de
bestaande nota's (open/deels_betaald) en het dossier mengt nota's en
betalingen chronologisch. `debiteuren.dossier` is een apart recht (naast
`betaling.lezen`), want §8.3 eist toegangslogging op het dossier van een
ander lid — de audit-entry `debiteuren.dossier_ingezien` zet de kijker als
persoon (FK bewees de noodzaak: persoon 0n bestaat niet).

**Ouderdomsanalyse op SQL-interval-rekenkunde.** Eerste versie gebruikte
`date >= interval` — bestaat niet in Postgres ('operator does not exist');
de peildatum wordt gecast (`${vandaag}::date - INTERVAL '29 days'`).
Grenzen: 0–30 = 29/0 dagen geleden t/m vandaag (incl.), 90+ = ouder dan 90.
Invariant in de test: som(buckets) == totaal openstaand, exact.

**Dossier is chronologisch gemengd, niet per soort.** Nota's en betalingen
(gekoppeld én verrekeningen) staan op datum naast elkaar — precies wat een
incassobureau of deurwaarder verwacht. De PDF-export van het dossier volgt
in G13; de datastructuur (soort, kenmerk, bedrag, omschrijving) is hier de
levering, zoals bij de AC5.7-PDF in G04.

---

## G11 — Aanmaningstraject (11-09-2026)

**Drie stappen als documenten, niet als status (§5.5/AC6.5).** Elke stap
(herinnering T+7 kosteloos, aanmaning T+21, ingebrekestelling T+45) is een
rij in `aanmaning` met de brieftekst als bewijs — `UNIQUE (nota_id, stap)`
maakt dubbele herinneringen onmogelijk. Termijnen instelbaar per VvE
(`aanmaning_instelling`, defaults letter §5.5); de deadline is verval +
dagen van de _nieuwe_ stap en wordt bewaakt (getest met T+2, T+9, T+30 als
weigeringen).

**De veertiendagenbrief is de aanmaning (AC6.5).** Voor consumenten moet de
brief waarin incassokosten worden aangezegd expliciet de wettelijke
veertiendagentermijn noemen; de aanmaning-tekst doet dat en is gemarkeerd
met `is_veertiendagen`.

**Kosten als aparte nota (AC6.6-letter, getest).** De WIK-incassokosten
(15%, min € 40) worden aangezegd op de aanmaning en geboekt bij de
ingebrekestelling; rente (instelbaar, per maand over het openstaande) erbij
als de grondslag niet 'geen' is. Beide als APARTE nota met eigen nummer uit
de G06-reeks (FOR UPDATE op het boekjaar, zelfde patroon als de
periode-generatie); de oorspronkelijke nota blijft onveranderd — getest op
bedrag én openstaand.

**Drizzle-les:** `.from(sql'boekjaar b')` met een kolomreferentie uit een
andere tabel faalt hard ("table nota is not part of the query"); de
boekjaar-vergrendeling loopt via `tx.execute(sql`SELECT id FROM boekjaar …
FOR UPDATE`)` — de ruwe execute is daar het juiste gereedschap.

---

## A05 — Leveranciers en verplichtingenregister (11-09-2026)

**G08-les tweede keer hard toegepast.** `verplichting_soort` stond al in
0001 — met de volledige soortenlijst uit de spec (liftkeuring,
brandmeldinstallatie, legionella, nen3140, opstalverzekering,
aansprakelijkheid, bestuurdersaansprakelijkheid, rechtsbijstand,
energielabel, overig). Eerste opzet had een eigen kortere enum; de
migratiefout kwam vóór de eerste testrun, in de buildfase. Vervolgens de
Drizzle-spiegel en de controller-validatie op de 0001-lijst gezet.

**Signaleringen live gerekend, niet opgeslagen.** De opzegsignalering
(AC12.4: 90 dagen vóór het opzegvenster) en de
verplichtingsherinneringen (T-60/T-14) zijn afgeleide vlaggen — opgeslagen
booleans raken uit de pas met elke peildatum. Getest met een contract
einddatum+30 (signaal aan) tegenover een ver contract (uit).

**Facturen (AC12.6) bewust beperkt.** De leveranciersfactuur volgt de
G06-kosten-nota (nummerreeks, grootboekrekening); de MJOP/melding-koppeling
volgt in M01/A04. De migratie laat die kolommen bewust weg in plaats van
dode FK's — vooruitverwijzingen horen bij het blok dat ze invult.

---

## A06 — Mededelingen en mailsjablonen (11-09-2026)

**Doelgroepen live opgemaakt, niet voorgecreëerd (AC13.1).** De
ontvangerslijst van een mededeling wordt per publicatie opgemaakt:
alle_leden = iedereen met een lopende rol_toewijzing; eigenaren = via
eigenaarschap op vandaag (daterange); bewoners = de rest. Geen
mededeling_ontvanger-tabel — de doelgroep van het verleden verandert niet
door later gewijzigde rollen, want de mail staat al in de wachtrij (§7.7).

**Sjabloonfout blokkeert nooit (AC13.3).** Het sjabloon is één rij per VvE
(afzendernaam, ondertekening, logo); zonder rij is `isDefault` waar en
valt de afzender terug op 'De VvE'. Per-ontvanger-fouten worden
overgeslagen zonder de rest te blokkeren — AC13.2's wachtrij neemt de
rest over.

**`mededeling_doelgroep` was nieuw** (niet in 0001 — gecheckt, G08-les
werkt): `mededeling_doelgroep` ('alle_leden','eigenaren','bewoners') in 0024. Geen aparte bewoners-tabel: de doelgroep 'bewoners' is nu
"leden-min-eigenaren" en wordt exact zodra V03 de rol 'bewoner' inlevert.

## F07 — MFA over HTTP (12-09-2026)

### Waarom dit blok terugkwam nadat het `klaar` was

De servicelaag van F07 was er en was getest, maar er was geen enkel endpoint: passkeys, TOTP
en herstelcodes waren niet te activeren. Daarmee was élk recht uit `GELDSTROOM_RECHTEN` voor
iedereen onbereikbaar, `boekjaar.afsluiten` voorop. De servicetests misten dat omdat ze de
services rechtstreeks aanriepen. Zie het [controlelogboek](controle-logboek.md), B-01/B-02.

### MFA is een step-up, geen inlogpoort

Dat volgt uit §7.6: de eis hangt aan het _recht_, niet aan de sessie. Wie is ingelogd mag het
portaal in; pas een geldstroomhandeling vraagt om de tweede factor. Het access-token draagt
daarna een `mfa`-claim waarop de RolGuard doorlaat. Vandaar `markeerMfaGeauthenticeerd` op de
tokenservice, naar het model van `kiesActieveVve`: de sessie wordt gecontroleerd, er komt een
vers token uit, en de `vve_id`-claim gaat mee — anders zou een step-up de tenantkeuze wissen.

De `mfa`-claim is een boolean en geen tekst. `verifieerAccessToken` leest hem als
`mfaClaim === true`, zodat de string `'false'` nooit voor waar door kan gaan. Hij staat
alleen in het token als hij waar is.

### Alles achter de SessieGuard, ook de passkey-authenticatie

De tweede factor volgt hier altijd op een geslaagde wachtwoordinlog, dus de persoon is al
bekend. Dat scheelt het hele pad waarin een onbekende bezoeker WebAuthn-opties opvraagt — en
dat is precies waar gebruikersopsomming op de loer ligt.

### Het scherm staat niet op het portaal

`/beveiliging` is een eigen route, bereikbaar vanaf alle drie de startschermen. Een sectie op
het portaal zou de verkeerde mensen bedienen: dat is het scherm van de eigenaar, terwijl de
applicatiebeheerder op `/beheer` landt en de VvE-beheerder op `/vve`. Juist die twee dragen
de geldstroomrechten. Een instelling die alleen bereikbaar is voor wie hem niet nodig heeft,
is geen instelling.

### Het secret wordt één keer getoond

Secret, otpauth-URI en tien herstelcodes komen één keer terug en staan daarna versleuteld
respectievelijk gehasht in de database. Zelfde afspraak als bij de wachtwoorduitgifte in V01,
en om dezelfde reden: zonder bruikbare mailflow is het scherm het enige kanaal. Let op de
keerzijde, die in de code is vastgelegd: `activeer` zet MFA meteen aan, ook als de gebruiker
het secret nooit in zijn app zet. Wegklikken zonder noteren betekent opnieuw activeren.

### Twee bugs die alleen een draaiende server liet zien

**`require` in een ESM-pakket.** `totp.ts` laadde otplib met een kale `require`. In het echte
Node-proces bestaat die daar niet: elke TOTP-handeling wierp `ReferenceError` en werd een 500
— ook in productie. Geen enkele test zag het, want de testrunner biedt CJS-interop. Nu
`createRequire(import.meta.url)`.

**De weigering was een 500.** `MfaVereistFout` viel als onbekende fout door de foutfilter en
leverde een serverfout met referentienummer op, in plaats van een 403 met uitleg. De
bestaande guardtest miste dat: die roept de guard rechtstreeks aan en toetst alleen dát hij
werpt, niet wat de gebruiker ziet. Nu vertaald naar 403.

### Wat F07 nog steeds niet doet

De poort toetst _bezit_ van een tweede factor, niet of die zojuist gebruikt is: wie TOTP
heeft geactiveerd komt er ook met een token van vóór de step-up langs. Dat is wat F07
oplevert; herauthenticatie per handeling stond in de F07-code aangekondigd voor F08 en is
daar niet gebouwd. Er staat nu een test die dit gedrag vastlegt, zodat de aanname niet
opnieuw verkeerd gelezen wordt. Het echte werk hoort bij I03 (vier-ogen en herauthenticatie).

## V03 — Eigenaarschap (12-09-2026)

### De somtoets kan niet in de database, de EXCLUDE's niet in de service

Migratie 0010 bewaakt met twee EX USING gist-constraints wat Postgres kan: geen twee keer
volledig eigendom (1000 promille) op dezelfde eenheid in dezelfde periode, en geen
overlappende periodes per (eenheid, persoon). Wat Postgres **niet** kan is een aggregaat in
een constraint: de som van de aandelen ≤ 1000 per dag (test 34: 600+600 geweigerd,
500+500 toegestaan). Die toets zit daarom in de service (`voegEigenaarToe`), direct vóór
de insert. Beide lagen bewaken dus wat zij bewaken kán; de tests toetsen beide paden,
ook de directe insert langs de service heen (23P01).

### Rato-verdeling via de grootste-restmethode, niet per persoon

Het verrekenoverzicht (AC2.5/AC9.6-geest) verdeelt het jaartotaal van de eenheid naar rato
over de eigenaarsperioden: gewicht = dagen in het jaar × aandeel, verdeling via
`verdeelGrootsteRest` uit `@vve/domein`. De som van de rijbedragen is daarmee exact gelijk
aan het jaartotaal — geen restcenten die verdwijnen of verdubbelen. Een eerdere opzet
filterde de nota's per persoon en vermenigvuldigde daarna met dagen/dagenInJaar in rauwe
cent-rekenkunde: fout bij een wissel binnen het jaar (de nota na de wissel hoort aan de
nieuwe eigenaar, maar zat op de oude persoon) en verboden door de F05-centregel. Historische
nota's blijven bewust aan de oorspronkelijke eigenaar gekoppeld; het overzicht verdeelt
alleen het jaartotaal van de eenheid.

### `totEnMet` is de laatste dag inclusief

De daterange bewaart `[start, eind)`; de weergave geeft "tot en met" terug (eind − 1 dag).
Historische rijen tonen daarmee de dag waarop het eigendom nog geldig was, open rijen
geven null. De parse van de daterange-tekst behandelt half-open ranges correct — een
eerdere parse las `[a,b)` als open range en verloor daarmee de einddatum van juist de
historische rijen.

### `SystemKlok.vandaag()` brak op Node 22

`formatToParts` levert óók de letterlijke scheiders als onderdelen; de oude code joeg alles
door één `join('/')` en splitste daarna opnieuw — op Node 22 resulteerde dat in
`"2026/-/09/-/12"`, maand NaN, en elke query met een default-datum crashte met pg-fout 22007
(invalid input syntax for type date). Vrijwel elke suite zou dit raken zodra een service een
default-vandaag nodig heeft. Nu per `type` gelezen (year/month/day) met een harde weigering
als Intl iets onleesbaars teruggeeft. Dit is een infrastructuurfix die buiten V03 om elk
toekomstig blok helpt.

### Wat V03 bewust niet doet

Een aandeelwijziging van een lopend eigenaarschap is een UPDATE op de rij (de somtoets
bewaakt alleen het toevoegen). Bulk-import en de CSV-flow horen bij V06; de notaris-PDF
van het verrekenoverzicht volgt bij het verzend-blok (G13-patroon, datastructuur eerst).
Huurders/bewoners (AC2.6) zijn een apart register en horen bij het blok dat hun beperkte
toegang uitwerkt.

## V05 — Documenten (12-09-2026)

### Opslag: bestandssysteem, niet de database — andersom dan G07

AC3.7 zegt het letterlijk: willekeurige (UUID) namen op schijf, buiten de webroot,
originele naam in de database. G07 bewaart de nota-PDF bewust als bytea in de db
(bewijslast bij het dossier); hier is het bestandssysteem de bewaarplaats. Het pad in
de database is **relatief** aan de opslagroot (`DOCUMENTEN_MAP`, verplicht uit de
omgeving, geen standaardwaarde — §8.2): de root verhuist mee met de omgeving zonder
dat de database het hoeft te weten.

### MIME server-side via magic bytes (test #31)

`fileTypeFromBuffer` uit `file-type` (nu expliciete dependency, was transitief) bepaalt
het type uit de inhoud — een uitvoerbaar bestand onder een `.pdf`-naam wordt geweigerd op
het gedetecteerde type, niet op de naam. De test seedt echte magic bytes (M\u005a-header
voor de weigering, volledige PNG-header mét IHDR-chunk voor de toelating: file-type 21
herkent de kop alleen met het eerste chunk erachter).

### Zichtbaarheid: de bewoner-bepaling gaat voor `alle_leden` (AC3.2)

AC3.2: huurders/bewoners zien uitsluitend documenten die expliciet als `bewoners`-
zichtbaar zijn gemarkeerd. Een bewoner is dus géén "lid" in de zin van `alle_leden` —
de regels staan in `zichtBepalerVanRollen` (export, één bron van waarheid): bestuur
ziet alles, een bewoner-zonder-eigenaarsrol uitsluitend 'bewoners', andere leden
'alle_leden'. De controller leest de rollen uit `rol_toewijzing` op de actieve VvE —
nooit uit de client.

### Versieketen als gelinkte lijst (AC3.3)

Een nieuwe versie verwijst via `eerdere_versie_id` naar de rij die hij vervangt, draait
versie+1 en zet de oude op `vervallen_op` (zichtbaar voor bestuur, weg uit de
standaardlijst). De metadata (titel, categorie, zichtbaarheid, tags) wordt van de oude
versie overgenomen — alleen de inhoud wisselt. Een vervallen versie kan niet nogmaals
vervangen worden (weigering).

### Twee klassiekers opnieuw ondervangen

**Seed-lookups met vve_id-scope.** De eerste lijst-query filterde alleen op
categorie/jaar — de gedeelde testcontainer-pool verbindt als superuser (BYPASSRLS), dus
lekte de lijst over VvE's heen en zag de beheerders-assert er één te veel. Nu staat
`eq(document.vveId, vveId)` in de WHERE, zoals in élke andere suite.

**Download is 404, niet 403** (§7.5 stap 6): bestaan is zelf al informatie; een
onzichtbaar document levert dezelfde fout als een onbekend document.

### Wat V05 bewust niet doet

De ZIP-download (AC3.6) levert nu de kandidatenlijst (gededupliceerde namen); het echte
dependency-vrije ZIP-formaat volgt het G07-PDF-patroon in het verzend-blok. PDF-tekst-
extractie en volledig-tekstzoeken over de inhoud is X03 (fase 7); het zoeken hier werkt
op titel, categorie, jaar en tags. ALV- en MJOP-koppelingen (AC3.4) zijn plain kolommen —
ze krijgen hun FK bij de blokken die die tabellen leveren (A05-patroon: geen dode FK's).

## V06 — Bulk-import (12-09-2026)

### Tabel-lezer dependency-vrij: CSV én XLSX met Node-kern

Het G07-PDF-besluit (leesbare minimale schrijver boven een grote bibliotheek) is hier de
leesvorm: `tabel-lezer.ts` parst CSV volgens RFC 4180 (quote-aware statemachine, scheiding
`,`/`;` automatisch op de kopregel) en XLSX als ZIP-van-XML — handmatige lokale-header-
walk, uitsluitend stored/deflate (andere methodes geweigerd), decompressie met
`zlib.inflateRawSync` (Node-kern), gedeelde strings + cel-walker met Excel-kolomletters
(A=0, AA=26). Geen 1,5 MB-parser voor één formaat. Beide formaten leveren dezelfde
koppen+rijen-vorm, zodat de import één pad kent.

### Validatie vooraf, dry-run, dan pas schrijven

De flow volgt AC2.7 letterlijk: kolomtoets (verplichte koppen) + per-rij veldtoetsen met
foutverzameling (niet eerste-gooien) — zonder te schrijven. Het dry-run-rapport beschrijft
per rij de actie die hij zou doen; `uitvoeren: true` is een bewuste tweede beslissing met
dezelfde invoer. Misvormde testrijen (te weinig kolommen) hebben twee rondes gekost: de
import weigerde ze terecht (kolomshift zette een e-mail op `breukdeel_noemer`) — de
service deugt, de testrijen moesten kloppen.

### Geen personen door de import; idempotente koppelingen

De import leest e-mail/naam/rol; wie het adres nog niet heeft krijgt de gewone V04-
uitnodiging (opak token, F10-wachtrij) — het token ís de autorisatie, en de registratie-
flow (F06) blijft de enige plek waar personen met wachtwoorden ontstaan. Bestaande
personen worden idempotent gekoppeld (geen dubbele lopende rij), bestaande eenheden bij
code hergebruikt: een tweede run is een no-op op db-niveau.

### Bewust-niet-doen

Rol `bewoner` in de import volgt later (AC2.6-register); de kolommen `eigenaar_*` zijn
nu eigenaar-only. XLSX-sheets vóór sheet1, datumceltypen en formules worden bewust niet
gelezen — het import-model is de CSV-kolomlijst; wie meer nodig heeft exporteert CSV.
De client-kant van de documenten volgt in V07 (eigenaarsportaal).

## V07 — Eigenaarsportaal (12-09-2026)

### Eigenaar-zicht, niet bestuur-zicht

Het overzicht retourneert uitsluitend de eenheden waar de opvrager _zelf_ een lopende
eigenaarsperiode voor heeft (`periode @> current_date` op persoonId). De RLS-policy
filtert op VvE, niet op persoon — het eigenaar-zicht is daarom een expliciete WHERE,
net als de seed-scope-regel in de tests. Een bewoner/zonder-eigenaarschap ziet een
lege lijst, geen andermans eenheden.

### E-mailwijziging hoort bewust niet bij AC14.3 in dit blok

De spec eist verificatie van het nieuwe adres. Dat is een eigen flow (opak token naar
het nieuwe adres, consumeerbaar zonder lopende sessie) en hoort bij het blok dat die
verificatie uitwerkt — niet als stil side-effect in het profiel-PATCH. De e-mail is
in het portaal leesbaar, nooit schrijfbaar; de PATCH-schema is `.strict()` en negeert
een `email`-veld met een foutmelding (mass-assignment-wachter, test #30).

### Het portaal is een leesvenster, geen bron van waarheid

Openstaande saldo's, creditsaldi en betalingen worden live gerekend uit de G06/G08-
tabellen (zelfde SQL als debiteuren/betalingen), nooit opgeslagen. Een tweede
berekening met dezelfde peildatum is identiek — daarom is er ook geen portaal-tabel.

### Client rekent nooit met centen (F12-discipline)

De centen-wachter staat ook op `apps/app`. De portaal-pagina formatteert via één
`euro(centen)`-helper; er is geen `+`/`-` op een veld met `_cent`-naam. De API levert
rauw (centen + metadata); de presentatie is clientwerk.

### Wat V07 bewust niet doet

AC14.4 (jaaropgave-PDF) volgt bij het verzend-/jaarrekening-blok (G08-data, G13-PDF-
patroon); "komende ALV met stukken" volgt bij A01 (de vergaderingstabel bestaat nog
niet); "actieve meldingen" volgt bij A04. De machtiging (M8/I02) komt met het incasso-
spoor. AC14.2 (VvE-wissel zonder opnieuw inloggen) is al werkend uit F08: POST
/auth/actieve-vve + VvE-keuzescherm; het portaal vertrouwt op de actieve VvE-claim.

## B07 — Proefbalans, saldibalans en grootboek (12-09-2026)

### Eén overzicht, geen twee

Proef- en saldibalans staan in de Nederlandse praktijk naast elkaar in één
vierkolommenoverzicht: per rekening de optelling debet en credit (de proef), en daarnaast
het saldo aan de kant waar het uitkomt (de saldi). Daarom één methode
`proefSaldiBalans` en niet twee. Een rekening met 25.000 debet en 12.500 credit houdt dus
twee tellingen maar één saldo van 12.500 debet; de creditkolom blijft leeg. Daar staat een
test op, want dat verschil is precies wat de twee begrippen onderscheidt.

### De controle die het overzicht zijn naam geeft

G02 bewaakt de balans per boeking, met `OnbalansFout` vóór het schrijven en de deferred
trigger als vangnet daaronder. Dat is de controle op het **schrijven**. `inBalans` is de
controle op het **lezen**, over het hele boekjaar heen, en vangt wat de eerste niet kan
vangen: een regel die buiten de boekingsservice om is aangepast, of een migratie die iets
heeft gebroken. Het wordt nageteld, niet aangenomen — en de test telt het op zijn beurt
met de hand na in plaats van `inBalans` te geloven omdat de service het zegt.

### Rekeningen zonder mutaties blijven staan

Een lege regel in de proefbalans is informatie: "hier is niets op geboekt". Wegfilteren
zou de lezer laten raden of de rekening niet bestaat of niet gebruikt is.

### Sorteren op datum, niet op id

Het grootboek sorteert op `datum`, dan `nummer`, dan regel-id. Sorteren op id alleen zou
een memoriaalboeking met terugwerkende datum onderaan zetten, en dan klopt het lopende
saldo in beeld niet met de volgorde die de lezer ziet.

### Geen geldstroomrecht op deze routes

`boekhouding.lezen` staat bewust niet in `GELDSTROOM_RECHTEN`. §8.5 beschermt het _muteren_
van geld; meekijken in de cijfers is juist wat een kascommissie moet kunnen zonder tweede
factor.

### Bedragen als getal, niet als `Bedrag`

De optelling gebeurt in SQL (`sum` over `bigint`-centen) en wat eruit komt wordt alleen nog
getoond. Zodra er weer mee gerekend wordt — de jaarrekening van B08 — hoort het via
`Bedrag` te gaan (§7.3). Dat staat als opmerking in de kop van de service, zodat B08 het
niet per ongeluk overneemt.

## B08 — Jaarrekening met PDF en XLSX (12-09-2026)

### Een eigen XLSX-schrijver, geen bibliotheek

§8.1 punt 5 noemt een gekaapte npm-afhankelijkheid als reëel risico, en §8.2 eist een
smalle productie-image. G07 schreef om die reden zijn eigen PDF-bouwer. Wat hier nodig is —
een tabel met tekst en getallen, geen formules of opmaakmotor — rechtvaardigt geen
`exceljs` met zijn afhankelijkhedenboom. `gemeenschappelijk/xlsx.ts` schrijft een ZIP met
`stored`-entries (geen deflate nodig) en SpreadsheetML met inline strings. Deterministische
bytes, zodat de test hem zonder xlsx-parser kan uitpakken en nalezen.

Getallen gaan als **getal** het blad in, en in euro's in plaats van centen. Binnen de
applicatie is de cent de eenheid (§5.1), maar wie een spreadsheet opent wil kunnen
optellen; de omrekening gebeurt op de rand, in de exportlaag, en nergens anders.

### Een gedeelde PDF-laag, want dit stuk past niet op één pagina

De nota van G07 is altijd één pagina; een jaarrekening niet. Vandaar
`gemeenschappelijk/pdf.ts`: dezelfde dependency-vrije aanpak, maar met meerdere pagina's en
een `PaginaOpbouw` die zelf bijhoudt wanneer de ruimte op is. `nota-pdf.ts` staat er nog
naast en kan later op deze laag; dat is een aparte stap met de G07-tests als vangnet, niet
iets om in dit blok mee te nemen.

### Het resultaat wordt afgeleid, niet opgezocht

Baten min lasten — bewust niet het saldo van een resultaatrekening. Dat saldo bestaat pas ná
het afsluiten (AC9.3), terwijl de jaarrekening juist vóór het afsluiten gelezen wordt: in de
ALV. Om dezelfde reden telt `inBalans` het resultaat mee in de controle
(activa = passiva + eigen vermogen + resultaat). Zonder die term zou de balans altijd
falen op precies het moment dat het stuk nodig is.

### Tekens: positief aan de eigen kant

Activa en lasten staan debet, passiva, eigen vermogen en baten credit; elk bedrag komt
positief in beeld aan de kant die bij de rekening hoort. Voor een vrijwilliger is een
negatief bedrag dat eigenlijk "andersom" betekent de grootste bron van verwarring in een
jaarrekening.

### Alleen een vastgestelde begroting is een maatstaf

De vergelijkende kolom telt een begroting met status `concept` niet mee: dat is nog geen
afspraak (AC5.1). Pas een vastgestelde begroting is iets om de realisatie tegen af te zetten.

### Eén exportroute, twee formaten

`GET …/jaarrekening/:id/export.pdf|xlsx` in plaats van twee routes. De inhoud is identiek,
alleen de verpakking verschilt; met twee routes ontstaat vroeg of laat verschil tussen de
twee. De bestanden gaan als `attachment` de deur uit: dit is een stuk voor de ALV dat mensen
bewaren, geen pagina om even te bekijken.
