# VvE-Beheerapplicatie

Beheerapplicatie voor zelfbeherende Verenigingen van Eigenaren: volledige financiële administratie (begroting, bijdragen, nota's, bankimport, SEPA-incasso, MJOP, jaarrekening), documentbeheer, vergaderingen en een portaal voor eigenaren.

## Documenten

| Document | Inhoud |
|---|---|
| [`VVE_APPLICATIE_SPEC.md`](VVE_APPLICATIE_SPEC.md) | Volledig functioneel en technisch ontwerp — de bindende bouwprompt (domeinbegrippen, bedrijfsregels, datamodel, API-architectuur). |
| [`WERKPLAN.md`](WERKPLAN.md) | Alle 70 werkblokken met afhankelijkheden en voortgang. Leidt de bouwvolgorde: eerst `todo`-blok waarvan alle afhankelijkheden `klaar` zijn. |
| [`docs/besluiten.md`](docs/besluiten.md) | Ontwerpkeuzes per werkblok, met onderbouwing. |

## Stack

- **API:** NestJS 11 (TypeScript strict), Zod-validatie, Drizzle ORM
- **Database:** PostgreSQL 16 met Row-Level Security (multi-tenant)
- **Client:** Ionic 8 + Angular (PWA eerst, Capacitor native later)
- **Achtergrondtaken:** pg-boss (wachtrij in Postgres)
- **Infra:** Docker Compose + Caddy (TLS/HSTS), single VPS
- **Kwaliteit:** ESLint `strict-type-checked`, Prettier, Vitest + Testcontainers, CI via GitHub Actions

## Repository-indeling (npm workspaces)

```
apps/api          NestJS-API (modules per domein, guards, auth, tenant, audit)
apps/app          Ionic-client (portaal eigenaren + beheerschermen)
packages/domein   Pure TypeScript-domeinlogica — geen NestJS, geen I/O, geen Date.now()
packages/contract Zod-schema's, gedeeld tussen API en client
infra             docker-compose, Dockerfile, Caddyfile, migratierunner
docs              besluiten, handleidingen, AVG
```

Harde regel: `packages/domein` is puur en wordt afgedwongen met ESLint-`no-restricted-imports` — alle berekeningen zijn daar unit-testbaar zonder database of HTTP.

## Ontwikkelen

```bash
npm install          # installeert alle workspaces (npm ci in CI)
npm run lint         # ESLint, blokkerend
npm run test         # Vitest over alle workspaces
npm run build        # tsc -b met project references
```

API lokaal draaien:

```bash
cp .env.voorbeeld .env          # daarna zelf vullen, rechten 600
docker compose -f infra/docker-compose.yml up -d
curl http://localhost/health    # {"status":"ok"} via Caddy
```

## Bindende principes (samenvatting uit de spec)

- Nederlandse VvE-terminologie is leidend: tabellen, klassen en UI-teksten zijn Nederlands.
- Alle bedragen integer in **eurocenten** (kolommen `_cent`, `bigint`) — nooit floats.
- Verdeling van bedragen via de **grootste-restmethode**; de som is altijd exact.
- **API-first:** elk endpoint direct aanroepbaar; autorisatie op de API én in de database via RLS.
- Kalenderdata (`date`) ondergaan nooit tijdzoneconversie; tijdstempels in UTC.
- Geen geheimen in de repository; base images op digests vastgezet; `npm ci`, nooit `npm install` in productie.