/**
 * Inlogservice — F06c (spec §7.6, test #29).
 *
 * De use-cases rond inloggen: wachtwoordverificatie met rate limiting
 * (5 pogingen per account per 15 minuten), token-uitgifte bij succes,
 * uitloggen en de apparatenlijst. Geen HTTP — de toekomstige controller
 * (F08) roept deze service aan.
 *
 * De foutklasse `OnjuisteInloggegevensFout` dekt bewust óf een onbekend
 * e-mailadres óf een verkeerd wachtwoord: de melding is identiek, zodat een
 * aanvaller niet kan tellen welke accounts bestaan (spec §7.6).
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { apparaatSessie } from '../../database/schema/apparaat-sessie.js';
import { persoon } from '../../database/schema/persoon.js';
import { rolToewijzing } from '../../database/schema/rol-toewijzing.js';
import { vve } from '../../database/schema/vve.js';
import type { Klok } from '../system-klok.js';
import type { ApparaatInfo, TokenService } from './token.js';
import { hashWachtwoord, verifieerWachtwoord } from './wachtwoord.js';

/**
 * Eén argon2-hash van een willekeurige waarde, om tegen te verifiëren wanneer het
 * account niet bestaat. Zonder deze stap keert een onbekend e-mailadres direct terug
 * terwijl een bestaand adres tientallen milliseconden argon2 kost: de melding is dan
 * wel identiek, maar de responstijd verraadt alsnog welke accounts bestaan. De hash
 * wordt één keer berekend en hergebruikt.
 */
let dummyHashBelofte: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashBelofte ??= hashWachtwoord(`nooit-een-echt-wachtwoord-${String(Date.now())}`);
  return dummyHashBelofte;
}

/** Grenzen uit spec §7.6. */
export const MAX_POGINGEN_PER_ACCOUNT = 5;
export const ACCOUNT_POGINGEN_VENSTER_MINUTEN = 15;

/** Foutklasse voor blokkades: de controller erft hem voor de HTTP-status. */
export class AccountGeblokkeerdFout extends Error {
  constructor(readonly geblokkeerdTot: Date) {
    super('Te veel mislukte inlogpogingen; het account is tijdelijk geblokkeerd.');
    this.name = 'AccountGeblokkeerdFout';
  }
}

/** Uniforme fout voor onjuiste inloggegevens (onbekend adres óf verkeerd wachtwoord). */
export class OnjuisteInloggegevensFout extends Error {
  constructor() {
    super('E-mailadres of wachtwoord onjuist');
    this.name = 'OnjuisteInloggegevensFout';
  }
}

/**
 * De sessie verwijst naar een persoon die niet (meer) actief is. Dat is geen
 * invoerfout van de client maar een ingetrokken account met een nog geldig
 * access-token; de controller maakt er een 401 van, zodat de client uitlogt.
 */
export class OnbekendPersoonFout extends Error {
  constructor() {
    super('Onbekend of gedeactiveerd account');
    this.name = 'OnbekendPersoonFout';
  }
}

/** Eén rij in de apparatenlijst (profiel-scherm, spec §7.6). */
export interface ApparaatRij {
  readonly sessieId: bigint;
  readonly platform: string | null;
  readonly apparaatNaam: string | null;
  readonly ipLaatste: string | null;
  readonly laatsteGebruiktOp: Date | null;
  readonly aangemaaktOp: Date | null;
  readonly actief: boolean;
}

/** Eén VvE waar deze persoon een lopende rol in heeft. */
export interface ProfielVve {
  readonly vveId: bigint;
  readonly naam: string;
  readonly plaats: string | null;
  readonly status: 'actief' | 'gearchiveerd';
  readonly boekjaarStartmaand: number;
  readonly rol: string;
}

/**
 * Wie ben ik, en waar hoor ik terecht te komen.
 *
 * De client kan dit niet uit het access-token afleiden: dat draagt alleen `sub`
 * (de persoons-id), een optionele `vve_id` en de MFA-markering — bewust, want
 * rollen in een token zijn rollen van het moment van uitgifte en verouderen
 * stil. Daarom vraagt de client het na het inloggen op, en beslist de server
 * wat waar is.
 */
export interface Profiel {
  readonly persoonId: bigint;
  readonly email: string;
  readonly naam: string;
  readonly isApplicatiebeheerder: boolean;
  readonly wachtwoordWijzigenVerplicht: boolean;
  /** Lopende rollen; leeg voor een eigenaar zonder beheerrol. */
  readonly vves: readonly ProfielVve[];
}

export interface InlogVerzoek {
  readonly platform?: string;
  readonly apparaatNaam?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface InlogUitkomst {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessieId: bigint;
  readonly persoonId: bigint;
}

/** De inlogservice. `TokenService` levert de sessies; de klok is geïnjecteerd. */
export interface InlogService {
  /**
   * Inloggen met e-mail + wachtwoord. Bij succes: tokens uitgegeven,
   * `mislukte_pogingen` gereset en `laatste_login_op` gezet. Bij falen:
   * poging geteld en (vanaf de vijfde) het account geblokkeerd tot
   * 15 minuten ná de laatste mislukte poging.
   */
  inlog(email: string, wachtwoord: string, info: InlogVerzoek): Promise<InlogUitkomst>;

  /** Apparatenlijst voor het profiel (alle sessie-rijen met status, §7.6). */
  apparaten(persoonId: bigint): Promise<ApparaatRij[]>;

  /**
   * Wie is dit, en welke VvE's beheert hij. De client kiest hiermee het
   * startscherm; de autorisatie zelf blijft op de endpoints staan.
   */
  profiel(persoonId: bigint): Promise<Profiel>;
}

/** `voornaam tussenvoegsel achternaam`, zonder dubbele spaties bij lege delen. */
function samengesteldeNaam(rij: {
  voornaam: string | null;
  tussenvoegsel: string | null;
  achternaam: string;
}): string {
  return [rij.voornaam, rij.tussenvoegsel, rij.achternaam]
    .filter((deel): deel is string => deel !== null && deel.trim() !== '')
    .join(' ');
}

export function maakInlogService(config: {
  readonly db: NodePgDatabase;
  readonly tokens: TokenService;
  /** Geïnjecteerd (spec §7.3): anders is de blokkadetermijn niet te testen zonder te wachten. */
  readonly klok: Klok;
}): InlogService {
  const { db, tokens, klok } = config;

  return {
    async inlog(email, wachtwoord, info) {
      // 1. Zoek de persoon (citext is case-insensitief, migratie 0001).
      const [rij] = await db.select().from(persoon).where(eq(persoon.email, email)).limit(1);

      if (!rij || rij.wachtwoordHash === null || !rij.actief) {
        // Identieke melding én vergelijkbare responstijd voor onbekend adres,
        // wachtwoordloos account en gedeactiveerd account (§7.6).
        await verifieerWachtwoord(wachtwoord, await dummyHash());
        throw new OnjuisteInloggegevensFout();
      }

      // 2. Blokkade check vóór verificatie (fail closed op het account).
      const nu = klok.nu();
      if (rij.geblokkeerdTot !== null && rij.geblokkeerdTot.getTime() > nu.getTime()) {
        throw new AccountGeblokkeerdFout(rij.geblokkeerdTot);
      }

      // 3. Verifieer. Elke mislukte poging wordt geteld; een geslaagde reset.
      const correct = await verifieerWachtwoord(wachtwoord, rij.wachtwoordHash);
      if (!correct) {
        // Een verlopen blokkade begint een nieuw venster. Zonder deze reset blijft
        // de teller op het maximum staan en levert élke volgende misser meteen weer
        // een blokkade van 15 minuten op — dan houdt iemand die alleen het
        // e-mailadres kent het account onbeperkt dicht met één poging per kwartier.
        const vensterVerlopen =
          rij.geblokkeerdTot !== null && rij.geblokkeerdTot.getTime() <= nu.getTime();
        const basis = vensterVerlopen ? 0 : rij.misluktePogingen;
        const pogingen = basis + 1;
        const blokkeerTot =
          pogingen >= MAX_POGINGEN_PER_ACCOUNT
            ? new Date(nu.getTime() + ACCOUNT_POGINGEN_VENSTER_MINUTEN * 60_000)
            : null;
        await db
          .update(persoon)
          .set({
            misluktePogingen: pogingen,
            geblokkeerdTot: blokkeerTot,
          })
          .where(eq(persoon.id, rij.id));
        throw new OnjuisteInloggegevensFout();
      }

      // 4. Geslaagd: reset teller, zet laatste login, geef tokens uit.
      await db
        .update(persoon)
        .set({
          misluktePogingen: 0,
          geblokkeerdTot: null,
          laatsteLoginOp: nu,
        })
        .where(eq(persoon.id, rij.id));

      const uit = await tokens.geefTokensUit({ id: rij.id }, {
        platform: info.platform,
      } as ApparaatInfo);
      return { ...uit, persoonId: rij.id };
    },

    async apparaten(persoonId) {
      const rijen = await db
        .select({
          sessieId: apparaatSessie.id,
          platform: apparaatSessie.platform,
          apparaatNaam: apparaatSessie.apparaatNaam,
          ipLaatste: apparaatSessie.ipLaatste,
          laatsteGebruiktOp: apparaatSessie.laatsteGebruiktOp,
          aangemaaktOp: apparaatSessie.aangemaaktOp,
          ingetrokkenOp: apparaatSessie.ingetrokkenOp,
          verlooptOp: apparaatSessie.verlooptOp,
        })
        .from(apparaatSessie)
        .where(eq(apparaatSessie.persoonId, persoonId));
      // Actief = niet ingetrokken én niet verlopen. `laatsteGebruiktOp` zegt daar
      // niets over: die wordt bij uitgifte al gezet, dus op die maatstaf zou een
      // ingetrokken sessie zich als actief voordoen — juist in het scherm waarin
      // iemand een gestolen sessie moet herkennen.
      const nu = klok.nu().getTime();
      return rijen.map(({ ingetrokkenOp, verlooptOp, ...r }) => ({
        ...r,
        actief: ingetrokkenOp === null && verlooptOp.getTime() > nu,
      }));
    },

    async profiel(persoonId) {
      const [ik] = await db
        .select({
          id: persoon.id,
          email: persoon.email,
          voornaam: persoon.voornaam,
          tussenvoegsel: persoon.tussenvoegsel,
          achternaam: persoon.achternaam,
          isApplicatiebeheerder: persoon.isApplicatiebeheerder,
          wachtwoordWijzigenVerplicht: persoon.wachtwoordWijzigenVerplicht,
        })
        .from(persoon)
        .where(and(eq(persoon.id, persoonId), eq(persoon.actief, true)))
        .limit(1);
      if (ik === undefined) throw new OnbekendPersoonFout();

      // Alleen lopende rollen: een beëindigde rol geeft geen toegang meer, en
      // mag dus ook geen startscherm opleveren.
      const rollen = await db
        .select({
          vveId: vve.id,
          naam: vve.naam,
          plaats: vve.plaats,
          status: vve.status,
          boekjaarStartmaand: vve.boekjaarStartmaand,
          rol: rolToewijzing.rol,
        })
        .from(rolToewijzing)
        .innerJoin(vve, eq(vve.id, rolToewijzing.vveId))
        .where(and(eq(rolToewijzing.persoonId, persoonId), isNull(rolToewijzing.eindDatum)));

      return {
        persoonId: ik.id,
        email: ik.email,
        naam: samengesteldeNaam(ik),
        isApplicatiebeheerder: ik.isApplicatiebeheerder,
        wachtwoordWijzigenVerplicht: ik.wachtwoordWijzigenVerplicht,
        vves: rollen,
      };
    },
  };
}
