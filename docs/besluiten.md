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
