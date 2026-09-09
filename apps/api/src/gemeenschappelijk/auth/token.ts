/**
 * `auth/token` — token-uitgifte en apparaat-sessies (F06b, spec §7.6, §6.3).
 *
 * Eén laag, geen HTTP (dat is F08). De service-API die een toekomstige
 * controller aanroept:
 *    - `geefTokensUit(persoon, apparaatInfo)` — een JWT-access-token (15 min)
 *     én een opake refresh-token (32 bytes CSPRNG; alleen de sha256-hex gaat
 *     naar de db, het ruwe token verlaat de db nooit; spec §8.2).
 *    - `verfris(refreshToken, apparaatInfo)` — rotatie: een nieuw paar, de
 *     oude wordt ongeldig (`vorige_token_hash`), en hergebruik van een reeds
 *     ingewisseld token trekt de **hele `familie_id`** in (test #35-kern,
 *     spec §7.6: "de enige praktische verdediging tegen een gestolen refresh
 *     token op een telefoon").
 *    - `trekSessieIn(sessieId)` / `trekAlleSessiesIn(persoonId)` — uitloggen /
 *     alle apparaten uitloggen.
 *
 * **Ontwerppunten (zie `docs/besluiten.md`):**
 *   - *HS256 met een symmetrisch omgevingsgeheim* (`JWT_SECRET`): voor een
 *    first-party, single-server applicatie (§7.6) is een enkel gedeeld
 *    geheim het eenvoudigst dat de eis "met omgevingsgeheim" toereikt. De
 *    keus en een weg naar ES256 (asymmetrisch, bij uitdaging van signing)
 *    staan in het besluitenlog.
 *   - *Klok-injectie:* de service neemt een `Klok` aan (default `SystemKlok`),
 *    zodat expiratie en verloop deterministisch getest kunnen worden zonder
 *    de echte tijd te manipuleren. De exp-check van de access-token loopt
 *    zowel door jose (tegen de systeemklok — defence in depth in productie)
 *    als expliciet via de geïnjecteerde klok (testvoorstelling).
 *   - *Rotatie door toevoegen* van een nieuwe rij per `verfris`: elke wissel
 *    maakt een nieuwe `apparaat_sessie`-rij in dezelfde `familie_id` (met
 *    `vorige_token_hash` die terugwijst naar het net-geconsumeerde token) en
 *    markeert de oude rij ingetrokken (reden `geroteerd`). Een familie omvat
 *    dus meerdere rijen; die vaste keten is wat "trek de **hele familie in**"
 *     (spec §7.6) concreet betekent. Rotatie verlengt de levensduur niet — de
 *    nieuwe rij erft `verloopt_op`, zodat een gestolen sessie niet oneindig
 *    verlengbaar is.
 *   - *Hergebruikdetectie:* een token dat nergens nog **actief** is maar wél
 *    bestaat als een `refresh_token_hash` (dan is het reeds geconsumeerd —
 *    gestolen of hergebruikt). De service trekt de hele `familie_id` in en
 *    werpt daarna `HergebruikGesignaleerdFout` — "de enige praktische
 *    verdediging tegen een gestolen refresh token op een telefoon" (spec §7.6,
 *    test #35-kern). De intrekking en de fout worden in die volgorde
 *    afgehandeld: de db-mutatie wordt in de transactie gecommit, de fout
 *    *erna* — een `throw` binnen de transactie zou anders het inname-
 *    effect ongedaan maken.
 *
 * Integratie met `mislukte_pogingen`/`geblokkeerd_tot` op `persoon` (rate
 * limiting, spec §7.6) is bewust NIET in dit deelstuk (deelstuk 3).
 */

import { JOSEError } from 'jose/errors';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { apparaatSessie } from '../../database/schema/apparaat-sessie.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type Klok, SystemKlok } from '../system-klok.js';

// ---------------------------------------------------------------------------
// Samenstelbaarheid
// ---------------------------------------------------------------------------

/**
 * Context per apparaat. Alle velden zijn optioneel; ontbrekende worden `null`
 * opgeslagen (de kolom `verloopt_op` is de enige not-null van de sessie
 * zelf en wordt door de service gevuld).
 */
export interface ApparaatInfo {
  /** 'web' | 'ios' | 'android' (spec §6.3 `platform`). */
  readonly platform?: string;
  readonly apparaatNaam?: string;
  /** Laatste IP, als text voor de `inet`-kolom. */
  readonly ip?: string;
  readonly userAgent?: string;
}

/** De database-client (node-postgres + Drizzle); tests voeren de gedeelde
 * test-db in, productcode de echte verbinding. */
type TokenDb = NodePgDatabase;

/** Configuratie van de service. Alles is overneembaar voor tests. */
export interface TokenServiceConfig {
  readonly db: TokenDb;
  /** Tijdsbron (default: `SystemKlok`). */
  readonly klok?: Klok;
  /** Het symmetrische geheim voor HS256. Default: `JWT_SECRET`. */
  readonly geheim?: string;
  /** Levensduur van een access-token in minuten. Default: 15 (spec §7.6). */
  readonly accessTokenMinuten?: number;
  /** Levensduur van een refresh-token in dagen. Default: 30. */
  readonly refreshDagen?: number;
}

// ---------------------------------------------------------------------------
// Fouten — specifiek, zodat de controller de juiste foutmelding kan retourneren
// ---------------------------------------------------------------------------

export abstract class TokenFout extends Error {
  protected constructor(melding: string) {
    super(melding);
    this.name = new.target.name;
    // Vervolg de `Error`-keten onder Node 15+.
    Error.captureStackTrace(this, this.constructor);
    }
}

/** De aangeboden refresh-token is niet bekend als actieve of ingewisselde. */
export class OnbekendTokenFout extends TokenFout {
  constructor() {
   super('Onbekend refresh-token');
    }
}

/** De sessie (of token) is verlopen. */
export class VerlopenTokenFout extends TokenFout {
  constructor() {
   super('Verlopen refresh-token');
    }
}

/**
 * Een reeds ingewisseld refresh-token wordt opnieuw aangeboden. De hele
 * `familie_id` is ingetrokken (spec §7.6, test #35). Dit is de "herbruik-"
 * signaal die een gestolen refresh token detecteert.
 */
export class HergebruikGesignaleerdFout extends TokenFout {
  constructor(readonly familieId: string) {
   super(`Hergebruik gedetecteerd voor familie ${familieId}; alle sessies ingetrokken`);
    }
}

// ---------------------------------------------------------------------------
// Uitvoer
// ---------------------------------------------------------------------------

export interface TokensUit {
  /** Het ondertekende JWT (15 min validiteit). */
  readonly accessToken: string;
  /** Het ruwe opake refresh-token (32 bytes, hex). Verlaat de db nooit. */
  readonly refreshToken: string;
  /** De id van de aangemaakte `apparaat_sessie`-rij. */
  readonly sessieId: bigint;
}

export interface VerfrisUit {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly persoonId: bigint;
}

// ---------------------------------------------------------------------------
// Constanten
// ---------------------------------------------------------------------------

const ISSUER = 'vve-api';
const AUDIENCE = 'vve';
const ACCESS_MINUTEN_DEFAULT = 15;
const REFRESH_DAGEN_DEFAULT = 30;
const DAG_MILISECONDEN = 24 * 60 * 60 * 1000;

const INTRA_UITGELOGD = 'uitgelogd';
const INTRA_ALLES = 'alle_apparaten_uitgelogd';
const INTRA_HERBRUIK = 'hergebruik_detectie';
const INTRA_GEROTEERD = 'geroteerd';
const INTRA_VERLOPEN = 'verlopen';

// ---------------------------------------------------------------------------
// Token-primitives (geen db, geen I/O) — separaat exporteerbaar
// ---------------------------------------------------------------------------

/** Maakt een nieuw, onvoorspelbaar opake refresh-token: 32 bytes CSPRNG, hex. */
export function genereerRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * `refresh_token_hash` is de sha256 van het ruwe token, hex (64 tekens —
 * past in `char(64)`). Het ruwe token wordt nergens opgeslagen (spec §8.2).
 */
export function hashVanToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Tekent een access-token (HS256) voor `persoonId` met een 15-minuut
 * validiteit (spec §7.6). `iss`/`aud` zijn correct gezet; `sub` is de
 * persoons-id als string (JWT vereist een string `sub`).
 */
export async function tekenAccessToken(
  persoonId: bigint,
  klok: Klok,
  config: { geheim: string; minuten: number },
): Promise<string> {
  const nu = klok.nu();
  const geheim = new TextEncoder().encode(config.geheim);
  const nuSec = Math.floor(nu.getTime() / 1000);
  return new SignJWT({ sub: String(persoonId) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(nuSec)
      .setExpirationTime(nuSec + config.minuten * 60)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(geheim);
}

export interface DecodedAccessToken {
  readonly sub: string;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string | string[];
}

/**
 * Verifieert en decodeert een access-token.
 *
 * Jose verifieert de ondertekening én de `exp`-claim tegen de **systeemklok**
 * (defence in depth in productie, waar de geïnjecteerde klok `SystemKlok` is).
 * Daaronder controleren we de `exp`-claim expliciet tegen de geïnjecteerde
 * `klok`, zodat een testen-voorgezeten klok een verlopen token detecteert
 * (spec §7.6 "verloopt na 15 min", test via de klok). Bij een ontekenaam of
 * een verlopen token wordt `JOSEError` gegooid.
 */
export async function verifieerAccessToken(
  token: string,
  klok: Klok,
  config: { geheim: string },
): Promise<DecodedAccessToken> {
  const geheim = new TextEncoder().encode(config.geheim);
  const uitslag = await jwtVerify(token, geheim, {
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance: 0,
      });
  const claims = uitslag.payload;
  const expSec = claims['exp'] ?? 0;
  if (klok.nu().getTime() > expSec * 1000) {
    throw new JOSEError('Token is verlopen (exp-claim)');
      }
  return {
    sub: claims['sub'] ?? '',
    exp: expSec,
    iss: claims['iss'] ?? '',
    aud: claims['aud'] ?? [],
      };
}

// ---------------------------------------------------------------------------
// De service
// ---------------------------------------------------------------------------

export interface TokenService {
  geefTokensUit(persoon: { readonly id: bigint }, info: ApparaatInfo): Promise<TokensUit>;
  verfris(refreshToken: string, info: ApparaatInfo): Promise<VerfrisUit>;
  trekSessieIn(sessieId: bigint): Promise<{ ingetrokken: boolean }>;
  trekAlleSessiesIn(persoonId: bigint): Promise<{ ingetrokken: number }>;
  readonly klok: Klok;
}

/**
 * Bouwt een `TokenService`. Alle afhankelijkheden worden geïnjecteerd zodat
 * tests een nepklok, een vaste `geheim`, en de test-db kunnen aanvoeren.
 */
export function maakTokenService(config: TokenServiceConfig): TokenService {
  const klok = config.klok ?? new SystemKlok();
  const geheimeBruto =
    config.geheim ??
    process.env['JWT_SECRET'] ??
      // Veilige dev-default — ZELFDE PATTERN als DATABASE_URL (spec §7.9).
      // NOOIT in productie: daar komt het geheim uit de omgeving (chmod 600).
      'dev-geheim-verander-dit-via-JWT_SECRET';
  if (!geheimeBruto || geheimeBruto.length < 16) {
    throw new Error(
       'JWT_SECRET (of config.geheim) moet minimaal 16 tekens lang zijn; ' +
         'een te kort geheim is een beveiligingsrisico (spec §8.2).',
        );
    }
  const accessTokenMinuten = config.accessTokenMinuten ?? ACCESS_MINUTEN_DEFAULT;
  const refreshDagen = config.refreshDagen ?? REFRESH_DAGEN_DEFAULT;

  async function geefTokensUit(
    persoon: { readonly id: bigint },
    info: ApparaatInfo,
      ): Promise<TokensUit> {
    const nu = klok.nu();
    const ruwToken = genereerRefreshToken();
    const tokenHash = hashVanToken(ruwToken);
    const verloopt = new Date(nu.getTime() + refreshDagen * DAG_MILISECONDEN);

    const [rij] = await config.db
        .insert(apparaatSessie)
        .values({
        persoonId: persoon.id,
        // familie_id laat de db genereren (gen_random_uuid, default).
        refreshTokenHash: tokenHash,
        vorigeTokenHash: null,
        platform: info.platform ?? null,
        apparaatNaam: info.apparaatNaam ?? null,
        ipLaatste: info.ip ?? null,
        userAgent: info.userAgent ?? null,
        verlooptOp: verloopt,
        laatsteGebruiktOp: nu,
        })
        .returning({ id: apparaatSessie.id });

    if (!rij) {
      throw new Error('apparaat_sessie-insert leverde geen rij op');
       }
    const accessToken = await tekenAccessToken(persoon.id, klok, {
      geheim: geheimeBruto,
      minuten: accessTokenMinuten,
       });
    return { accessToken, refreshToken: ruwToken, sessieId: rij.id };
     }

  /**
   * Bepaalt in één transactie de uitkomst van een refresh-aanbod; de
   * db-mutaties (rotatie/inname) worden gecommit, de fout wordt *erna*
   * gegooid — want een `throw` binnen de callback van `db.transaction`
   * rolt terug en zou het inname-effect ongedaan maken.
   */
  type VerfrisUitkomst =
     | { readonly type: 'rotatie'; readonly persoonId: bigint; readonly nieuwRuw: string }
     | { readonly type: 'verlopen' }
     | { readonly type: 'herbruik'; readonly familieId: string }
     | { readonly type: 'onbekend' };

  async function verfris(refreshToken: string, info: ApparaatInfo): Promise<VerfrisUit> {
    const nu = klok.nu();
    const hash = hashVanToken(refreshToken);

    const uitkomst: VerfrisUitkomst = await config.db.transaction(async (tx) => {
      // Stap 1: een ACTIEVE rij (nog niet ingetrokken) met dit refresh_token?
      const [rij] = await tx
          .select()
          .from(apparaatSessie)
          .where(and(eq(apparaatSessie.refreshTokenHash, hash), isNull(apparaatSessie.ingetrokkenOp)))
          .limit(1);

      if (rij) {
        if (rij.verlooptOp.getTime() < nu.getTime()) {
          // Markeer expliciet ingetrokken (committed), throw daarna.
          await tx
            .update(apparaatSessie)
            .set({ ingetrokkenOp: nu, intrekkingReden: INTRA_VERLOPEN, laatsteGebruiktOp: nu })
            .where(eq(apparaatSessie.id, rij.id));
          return { type: 'verlopen' } as const;
           }

         // Roteren door toevoegen: een nieuwe rij in dezelfde `familie_id` met
         // het net-geconsumeerde token in `vorige_token_hash`; de oude rij gaat
         // ingetrokken (reden `geroteerd`). De levensduur wordt niet verlengd —
         // de nieuwe rij erft `verloopt_op` — zodat een gestolen sessie niet
         // oneindig verlengbaar is.
        const nieuwRuw = genereerRefreshToken();
        const nieuwHash = hashVanToken(nieuwRuw);

        await tx
            .update(apparaatSessie)
            .set({
            ingetrokkenOp: nu,
            intrekkingReden: INTRA_GEROTEERD,
            laatsteGebruiktOp: nu,
              })
            .where(eq(apparaatSessie.id, rij.id));
        await tx
            .insert(apparaatSessie)
            .values({
            persoonId: rij.persoonId,
            familieId: rij.familieId,
            refreshTokenHash: nieuwHash,
            vorigeTokenHash: hash,
            platform: info.platform ?? rij.platform,
            apparaatNaam: info.apparaatNaam ?? rij.apparaatNaam,
            ipLaatste: info.ip ?? rij.ipLaatste,
            userAgent: info.userAgent ?? rij.userAgent,
            verlooptOp: rij.verlooptOp,
            laatsteGebruiktOp: nu,
              });
        return { type: 'rotatie', persoonId: rij.persoonId, nieuwRuw } as const;
        }

        // Stap 2: geen actieve rij met dit token. Bestaat het dan als een
        // (verouderde, reeds ingetrokken) `refresh_token_hash`? Dan is het
        // geconsumeerd — hergebruik (gestolen of hergebruikt). Trek de HELE
        // `familie_id` in. `refresh_token_hash` is UNIQUE, dus op dit punt is
        // er hooguit één rij met deze hash; die is per definitie reeds
        // ingetrokken (de actieve-zoek is al mislukt).
      const [herbruikt] = await tx.select().from(apparaatSessie).where(eq(apparaatSessie.refreshTokenHash, hash)).limit(1);
      if (herbruikt) {
        await tx
            .update(apparaatSessie)
            .set({ ingetrokkenOp: nu, intrekkingReden: INTRA_HERBRUIK })
            .where(and(eq(apparaatSessie.familieId, herbruikt.familieId), isNull(apparaatSessie.ingetrokkenOp)));
        return { type: 'herbruik', familieId: herbruikt.familieId } as const;
        }

      return { type: 'onbekend' } as const;
       });

    switch (uitkomst.type) {
      case 'verlopen':
        throw new VerlopenTokenFout();
      case 'herbruik':
        throw new HergebruikGesignaleerdFout(uitkomst.familieId);
      case 'onbekend':
        throw new OnbekendTokenFout();
      case 'rotatie': {
        const accessToken = await tekenAccessToken(uitkomst.persoonId, klok, {
          geheim: geheimeBruto,
          minuten: accessTokenMinuten,
            });
        return {
          accessToken,
          refreshToken: uitkomst.nieuwRuw,
          persoonId: uitkomst.persoonId,
            };
       }
     }
    }

  async function trekSessieIn(sessieId: bigint): Promise<{ ingetrokken: boolean }> {
    const nu = klok.nu();
    const [geupdate] = await config.db
        .update(apparaatSessie)
        .set({ ingetrokkenOp: nu, intrekkingReden: INTRA_UITGELOGD })
        .where(and(eq(apparaatSessie.id, sessieId), isNull(apparaatSessie.ingetrokkenOp)))
        .returning({ id: apparaatSessie.id });
    return { ingetrokken: geupdate !== undefined };
     }

  async function trekAlleSessiesIn(persoonId: bigint): Promise<{ ingetrokken: number }> {
    const nu = klok.nu();
    const resultaten = await config.db
        .update(apparaatSessie)
        .set({ ingetrokkenOp: nu, intrekkingReden: INTRA_ALLES })
        .where(and(eq(apparaatSessie.persoonId, persoonId), isNull(apparaatSessie.ingetrokkenOp)))
        .returning({ id: apparaatSessie.id });
    return { ingetrokken: resultaten.length };
     }

  return {
   geefTokensUit,
   verfris,
   trekSessieIn,
   trekAlleSessiesIn,
   klok,
    };
}
