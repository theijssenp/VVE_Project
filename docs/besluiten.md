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
