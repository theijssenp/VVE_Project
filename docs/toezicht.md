# Toezicht op de werkblokken

Bijgehouden door de overseer-sessie. Elke keer dat een blok klaar is, wordt het hier
gecontroleerd tegen `VVE_APPLICATIE_SPEC.md` en de opdracht in `.orchestratie/`, waar
nodig verbeterd, en apart gecommit (bericht `FXX-review: ...`).

## Huidig doel

**F11** — Ionic-schil: routing, tokenopslag (cookie op web, Secure Storage native),
HTTP-interceptor, foutafhandeling, inlog- en MFA-schermen. Status: **nog niet gestart**.
(In de werkboom staat wel al ongecommit werk aan `auth/wachtwoord-generator.ts` en aan
`eslint.config.mjs`, dat op F12 lijkt.)

Klaar-signaal: een commit die met `F11:` begint of `F11 klaar` bevat, clientcode in
`apps/app/src/`, en een schone werkboom.

Aandacht: §7.6 en §7.8. Tokens nooit in `localStorage`; op web een httpOnly-cookie voor de
refresh, in de app Secure Storage. En de `client`-claim moet server-side worden afgedwongen
(test 36), niet door de client zelf.

**Openstaand uit eerdere blokken, hoort in het blok dat het raakt:**

- rate limiting per IP (§7.6 vraagt ook 20 per IP) — F06c-review;
- `moetHerhashen` aanroepen bij inloggen (§8.1) — F06a/F06c-review;
- de wachtwoordmail moet `gevoelig: true` zetten (§8.3) — F10-review.

## Werkwijze per blok

1. Opdracht lezen (`.orchestratie/FXX_opdracht.md`) en de genoemde spec-paragrafen.
2. Kwaliteitsketen draaien: lint, format:check, test, build, audit, en waar van
   toepassing de compose- en databasecontroles.
3. Claims verifiëren in plaats van aannemen — wat in `docs/besluiten.md` staat, natesten.
4. Verbeteren waar nodig, in een aparte commit, en niets meecommitten van het blok dat
   op dat moment in uitvoering is.
5. Deze tabel bijwerken en het doel op het volgende blok uit fase 0 zetten.

## Uitgevoerde controles

| Blok | Gecontroleerd | Uitkomst                                                                                                                                                                                                                                                                                                                                                                                         | Reviewcommit |
| ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| F01  | 08-09-2026    | Voldeed aan de opdracht. Zeven correcties: format:check en npm audit ontbraken in CI, `apps/app` was uitgesloten van linting, niet-werkende `allowDefaultProject`, ontbrekende grenscontroles in `verdeelGrootsteRest`, test vergeleek met `.sort()` en toetste de volgorde niet. Verdeelalgoritme geverifieerd tegen een exacte BigInt-referentie over 250.000 gevallen: geen afwijkingen.      | `743dc9d`    |
| F02  | 08-09-2026    | Draaide aantoonbaar, maar de `.env` bereikte de container niet: `environment:` wint van `env_file:`, en interpolatie leest `infra/.env` in plaats van de repo-root — Postgres startte met de default `lokal`. Verder Caddy zonder volumes (certificaten en logs weg bij herstart), databasesecrets in de Caddy-omgeving, geen beveiligingsheaders, en twee onjuiste claims in `infra/README.md`. | `2dbc17c`    |
| F03  | —             | wacht op afronding                                                                                                                                                                                                                                                                                                                                                                               | —            |

## Openstaand punt: twee sessies in één werkboom

Dit is nu twee keer misgegaan en is geen theoretisch bezwaar meer.

- Bij F01 nam commit `4ab4f92` van de bouwsessie een nog niet gecommitte wijziging van de
  overseer mee.
- Bij F03 bewerkte de bouwsessie `run-migraties.ts` terwijl de reviewwijzigingen erin
  stonden; een regelgebaseerde patch op verschoven regelnummers liet een niet-parseerbaar
  bestand achter. Hersteld via `git checkout HEAD --` en opnieuw aanbrengen.

Werkafspraak zolang dit zo blijft: reviewcommits noemen altijd expliciete paden (nooit
`git add -A`), en een review start pas als de werkboom schoon is. Beter zou zijn: de
bouwsessie pauzeren tijdens een review, of de review in een aparte git-worktree doen.

## Gereedschapsnotitie

`find -newermt '-N minutes'` levert op deze machine (BSD find) geen resultaten op, ook niet
voor bestanden die net zijn gewijzigd. Gebruik `ls -lT` voor tijdstempels; die klopt wel.
