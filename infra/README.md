# Infra — Docker Compose-fundament (blok F02)

Productie-omgevingsskelet voor de VvE-applicatie, conform
`VVE_APPLICATIE_SPEC.md` §7.9 (Draaien en beheren) en §8.2 (Toeleveringsketen).
Dit blokket bevat géén databasecode of migraties (dat is F03).

## Bestand

| Bestand              | Doel                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` | Drie services: `postgres` (PG 16), `api` (NestJS), `caddy` (reverse proxy). Base images zijn op **digest** vastgezet (niet `:latest`). |
| `api.Dockerfile`     | Multi-stage build (builder → runtime), non-root user, `npm ci` met lockfile, geen devDependencies in de runtime-stage.                 |
| `Caddyfile`          | Minimale Caddy-config; reverse-proxied naar `api:3000`. Lokaal op HTTP poort 80.                                                       |
| `.env.voorbeeld`     | Kopieer naar `.env` en vullen. Bevat géén echte secrets.                                                                               |

## Lokaal draaien

```bash
# 1. Vullen de .env (secrets buiten de repo; rechten 600):
cp .env.voorbeeld .env
chmod 600 .env
# pas de POSTGRES_PASSWORD hierin aan naar een sterk, werkend secret.

# 2. Valideer de compose-file:
docker compose -f infra/docker-compose.yml config

# 3. Opstarten en controleren:
docker compose -f infra/docker-compose.yml up -d
# wát tot de containers healthy zijn (healthchecks), daarna:
curl -s http://localhost/health
# verwacht: {"status":"ok"}  (via Caddy, die doorsturen naar api:3000)

# 4. Stoppen (volumes blijven behouden):
docker compose -f infra/docker-compose.yml down
```

## Secrets-bewaking (spec §7.9)

- De echte `.env` staat **buiten git** (`.gitignore`) en bevat de echte wachtwoorden.
- Bestandsrechten **`600`**: `chmod 600 .env` (lees/schrijf voor de eigenaar alleen).
- De encryptiesleutels voor IBAN-kolommen (komt in F03/B01) mogen **niet** in dezelfde
  backup staan als de database — anders is de versleuteling zinloos. In dit blokket
  nog niet van toepassing.

## Security-keuzes in de compose-file

- **Postgres is niet publiek blootgesteld.** De enige poortmapping is op
  `127.0.0.1` (lokaal ontwikkel-mapping); de default is geen mapping op `0.0.0.0`.
  In productie (zie `.env.voorbeeld`) blijft de mapping weg en is Postgres alleen
  bereikbaar van binnenuit het compose-netwerk.
- De **api**-luistert op `3000` binnen het netwerk; Caddy is de enige service met
  een naar-buiten-richting poort (80).
- Alle services draaien met een **healthcheck**; `api` gebruikt `GET /health`
  (bestaand NestJS-endpoint) als healthcheck.
- De `api`-service start als **`appuser`** (UID 1001), niet root.
- De postgres-container draait met `--network-alias postgres` zodat de URL
  van de compose-file niet afhankelijk is van de interne container-naam.

## Base-image digests

`docker compose build`/`up` gebruikt digests in plaats van `:latest` (spec §8.2:
"Bouw de productie-image met een lockfile en een vastgezette base image (digest,
geen `:latest`).") Zie `docs/besluiten.md` → **F02** voor de exacte digest
waarden.

## Aandachtspunten op de CI-machine

De digest-rij in `docker-compose.yml` en `api.Dockerfile` bevat digest
waarden die gelden op ARM64 (Apple Silicon). Voor een x86 CI-pipeline met
`platform: linux/amd64` is het digest te vervagen met de AMD64-digest (zie
`docker manifest inspect` uit `docs/besluiten.md`). De CI in `.github/workflows/ci.yml`
draait op `ubuntu-latest` (x86).
