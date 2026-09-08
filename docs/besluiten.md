# Beslutslog — VvE-monorepo

Ontwerp- en afwikkelingen die tijdens de werkblokken zijn genomen. Elke keuze staat onder
een datum- en blok-ID, zodat een latere sessie niet opnieuw hoeft te raden waarom het zo is.

---

## F01 — Monorepo-fundament (08-09-2026)

**Keuze: ESLint flat config met `projectService` (type-aware) in plaats van een statische
`project:`-lijst.**
Motive: met npm workspaces en cross-pakket-imports is `projectService: true`
(typescript-eslint v8) stabiel dan een handmatige `parserOptions.project`-lijst die per bestand
moet kloppen. `tsconfigRootDir` wijst naar de repo-root zodat elke workspace zijn eigen
tsconfig pakt. `allowDefaultProject: true` zorgt dat config-/build-bestanden die buiten elk
tsconfig vallen (deze eigen `eslint.config.mjs`, de `vitest.config.ts`) nog linten in plaats
van met `type information not available` te crashen.

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
- `no-restricted-syntax` vangen `new Date()` en `Date.now()`/`Date.parse()` als expressies;
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
