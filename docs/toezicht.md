# Toezicht op de werkblokken

Bijgehouden door de overseer-sessie. Elke keer dat een blok klaar is, wordt het hier
gecontroleerd tegen `VVE_APPLICATIE_SPEC.md` en de opdracht in `.orchestratie/`, waar
nodig verbeterd, en apart gecommit (bericht `FXX-review: ...`).

## Huidig doel

**F03** — Drizzle-opzet, migratierunner, Testcontainers-harnas, eerste migratie
(`vve`, `persoon`). Status: **in uitvoering** door de bouwsessie.

Klaar-signaal: een commit die F03 afmeldt (patroon `F03` in het bericht), een schone
werkboom, en aanwezige bestanden in `apps/api/src/database/schema/` en
`apps/api/src/database/migraties/`.

## Werkwijze per blok

1. Opdracht lezen (`.orchestratie/FXX_opdracht.md`) en de genoemde spec-paragrafen.
2. Kwaliteitsketen draaien: lint, format:check, test, build, audit, en waar van
   toepassing de compose- en databasecontroles.
3. Claims verifiëren in plaats van aannemen — wat in `docs/besluiten.md` staat, natesten.
4. Verbeteren waar nodig, in een aparte commit, en niets meecommitten van het blok dat
   op dat moment in uitvoering is.
5. Deze tabel bijwerken en het doel op het volgende blok uit fase 0 zetten.

## Uitgevoerde controles

| Blok | Gecontroleerd | Uitkomst | Reviewcommit |
| --- | --- | --- | --- |
| F01 | 08-09-2026 | Voldeed aan de opdracht. Zeven correcties: format:check en npm audit ontbraken in CI, `apps/app` was uitgesloten van linting, niet-werkende `allowDefaultProject`, ontbrekende grenscontroles in `verdeelGrootsteRest`, test vergeleek met `.sort()` en toetste de volgorde niet. Verdeelalgoritme geverifieerd tegen een exacte BigInt-referentie over 250.000 gevallen: geen afwijkingen. | `743dc9d` |
| F02 | 08-09-2026 | Draaide aantoonbaar, maar de `.env` bereikte de container niet: `environment:` wint van `env_file:`, en interpolatie leest `infra/.env` in plaats van de repo-root — Postgres startte met de default `lokal`. Verder Caddy zonder volumes (certificaten en logs weg bij herstart), databasesecrets in de Caddy-omgeving, geen beveiligingsheaders, en twee onjuiste claims in `infra/README.md`. | `2dbc17c` |
| F03 | — | wacht op afronding | — |

## Openstaand punt

Twee sessies werken in dezelfde werkboom. Dat is tot nu toe goed gegaan, maar
`4ab4f92` nam een nog niet gecommitte wijziging van de overseer mee in een commit van
de bouwsessie. Reviewcommits blijven daarom strikt beperkt tot expliciet genoemde paden.
