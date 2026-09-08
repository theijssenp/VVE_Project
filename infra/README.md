# Infra — Docker Compose-fundament (blok F02)

Productie-omgevingsskelet voor de VvE-applicatie, conform `VVE_APPLICATIE_SPEC.md`
§7.9 (Draaien en beheren) en §8.2 (Toeleveringsketen). Dit blok bevat géén
databasecode of migraties — dat is F03.

## Bestanden

| Bestand              | Doel                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` | Drie services: `postgres` (PG 16), `api` (NestJS), `caddy` (reverse proxy). Base images op **digest**, niet op `:latest`. |
| `api.Dockerfile`     | Multi-stage build (builder → runtime), non-root, `npm ci` met lockfile, geen devDependencies in de runtime-stage.         |
| `Caddyfile`          | Reverse proxy naar `api:3000` met beveiligingsheaders. Lokaal HTTP op poort 80; TLS volgt bij de productie-omschakeling.  |
| `../.env.voorbeeld`  | Kopieer naar `../.env` en vul in. Bevat géén echte secrets.                                                               |

## Lokaal draaien

> **`--env-file .env` is verplicht.** Compose leest voor interpolatie (`${...}`) het
> `.env`-bestand naast de compose-file — dus `infra/.env` — en niet de repo-root.
> Zonder de vlag vallen alle waarden terug op de defaults in de compose-file.
> Op `POSTGRES_PASSWORD` staat daarom een `:?`, zodat het vergeten van de vlag een
> harde fout geeft in plaats van een stille start met een zwak wachtwoord.

```bash
# 1. Secrets buiten de repo, rechten 600:
cp .env.voorbeeld .env
chmod 600 .env
# pas POSTGRES_PASSWORD aan naar een sterk, uniek wachtwoord.

# 2. Valideer de compose-file:
docker compose --env-file .env -f infra/docker-compose.yml config

# 3. Opstarten en controleren:
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
# wacht tot de healthchecks groen zijn, daarna:
curl -s http://localhost/health
# verwacht: {"status":"ok"}  (via Caddy, die doorstuurt naar api:3000)

# 4. Stoppen (volumes blijven behouden):
docker compose --env-file .env -f infra/docker-compose.yml down
```

`down -v` verwijdert óók de volumes, inclusief de database. Gebruik dat alleen
bewust: het `POSTGRES_PASSWORD` werkt alleen bij het initialiseren van een leeg
volume. Wijzig je het wachtwoord van een bestaande database, doe dat dan met
`ALTER USER` en niet door de variabele aan te passen — die wordt dan genegeerd.

## Omgang met secrets (spec §7.9)

- De echte `.env` staat **buiten git** (`.gitignore`) en bevat de werkelijke wachtwoorden.
- Bestandsrechten **`600`**: `chmod 600 .env`.
- De versleutelingssleutels voor IBAN-kolommen (F03/B01) mogen **niet** in dezelfde
  backup staan als de database — anders is de versleuteling zinloos. In dit blok nog
  niet van toepassing.
- Caddy krijgt bewust géén databasesecrets in zijn omgeving; het heeft ze niet nodig.

## Beveiligingskeuzes in de compose-file

- **Postgres is niet publiek blootgesteld.** De enige poortmapping staat op
  `127.0.0.1` (lokale ontwikkelmapping). In productie zet de operator
  `POSTGRES_PORT_MAPPING=` leeg, waarna Postgres alleen binnen het compose-netwerk
  bereikbaar is. Authenticatie op elk netwerkpad is `scram-sha-256`; alleen
  container-loopback staat op `trust` (standaard van het officiële image).
- De **api** luistert op `3000` binnen het netwerk en heeft geen host-mapping.
  **Caddy** is de enige service met een poort naar buiten (80).
- De api-container draait als de ingebouwde **`node`**-gebruiker (UID 1000), niet als root.
- Alle services draaien met `no-new-privileges` en met een healthcheck. De api gebruikt
  het bestaande `GET /health`; die healthcheck staat alleen in de Dockerfile, zodat er
  niet twee definities uit elkaar kunnen lopen.
- `caddy_data` bewaart de TLS-certificaten. Zonder dat volume vraagt Caddy bij elke
  herstart nieuwe certificaten aan en loop je tegen de Let's Encrypt-limieten.
  `caddy_logs` zorgt dat toegangslogs een `down` overleven.

## Base-image digests

Alle images staan op digest vastgezet (spec §8.2). De gebruikte waarden staan in
`docs/besluiten.md` → **F02**. Het zijn **manifest-list-digests** (OCI image index):
Docker kiest per host het juiste platform-archief, dus dezelfde digest werkt zowel op
arm64 (Apple Silicon) als op amd64 (CI). Geverifieerd met `docker manifest inspect`;
er is geen aparte digest per architectuur nodig.
