/**
 * Uitnodigingen-service — blok V04 (spec §3.3, §6.3 `uitnodiging` · AC2.2).
 *
 * De beheerder voegt per eenheid nul of meer e-mailadressen toe; per adres
 * ontstaat een uitnodiging met een opak token (§3.3-aanbevolen variant:
 * registratielink i.p.v. een gemaild wachtwoord — dat blijft onbeperkt in de
 * mailbox staan). Twee paden bij het registreren:
 *
 * - **Onbekend adres** → nieuwe `persoon` met wachtwoord + meteen een
 *   `rol_toewijzing` als eigenaar (de token-link kiest het wachtwoord).
 * - **Bestaand persoon** (eigenaar in een andere VvE) → wordt direct
 *   gekoppeld; zijn antwoord is alleen de "u bent toegevoegd"-mail (§3.3
 *   stap 2) — geen registratielink.
 *
 * De eenheid zonder e-mailadres moet volledig kunnen functioneren (§3.3
 * stap 4): het aanmaken van een eenheid is bewust al mogelijk zónder
 * uitnodiging — V02's AC2.1-pad (beheerder is eigenaar) dekt dat.
 *
 * **Geen HTTP hier.** De token-uitgifte en -verificatie zijn service-API; de
 * controller vertaalt naar HTTP en houdt de `gevoelig`-mail via de F10-
 * wachtrij. De wachtrij faalt nooit op SMTP: een onbereikbare mailserver
 * mag de beheerdersactie niet blokkeren (§7.7).
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { eigenaarschap } from '../../database/schema/eigenaarschap.js';
import { persoon } from '../../database/schema/persoon.js';
import { rolToewijzing } from '../../database/schema/rol-toewijzing.js';
import { uitnodiging } from '../../database/schema/uitnodiging.js';
import { vve } from '../../database/schema/vve.js';
import { wooneenheid } from '../../database/schema/wooneenheid.js';
import { maakAuditService } from '../../gemeenschappelijk/audit/audit-service.js';
import type { MailServiceInterface } from '../../gemeenschappelijk/mail/mail-service.js';
import type { Klok } from '../../gemeenschappelijk/system-klok.js';
import { inTenantTransactie } from '../../gemeenschappelijk/tenant/tenant-context.js';

/** Uitnodigingen verlopen na 30 dagen (spec §3.3 stap 3). */
export const GELDIGHEID_DAGEN = 30;
const DAG_MS = 24 * 60 * 60 * 1000;

export class InvoerFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'InvoerFout';
  }
}

export class NietGevondenFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = 'NietGevondenFout';
  }
}

/** De link is verlopen of al gebruikt; de gebruiker ziet één uniforme melding. */
export class OngeldigTokenFout extends Error {
  constructor() {
    super('Uitnodiging onbekend, verlopen of al gebruikt.');
    this.name = 'OngeldigTokenFout';
  }
}

export interface UitnodigingRij {
  readonly id: bigint;
  readonly email: string;
  readonly rol: string;
  readonly eenheidCode: string | null;
  readonly verlooptOp: Date;
  readonly gebruiktOp: Date | null;
  readonly aantalVerzonden: number;
  readonly verzondenOp: Date | null;
  /** §3.3 stap 3-status: de beheerder ziet per eenheid waar hij staat. */
  readonly status: 'uitgenodigd' | 'gebruikt';
}

export interface UitnodigingenOverzicht {
  readonly rijen: readonly UitnodigingRij[];
}

export interface UitnodigingVerzoek {
  readonly email: string;
  readonly eenheidId?: bigint | null;
  readonly rol: 'eigenaar' | 'bewoner';
}

export interface UitnodigingenService {
  /** Nodigt één adres uit voor (of koppelt het direct aan) een eenheid. */
  nodigUit(
    vveId: bigint,
    verzoek: UitnodigingVerzoek,
    doorPersoonId: bigint,
  ): Promise<{ uitnodigingId: bigint; bestaandPersoon: boolean; token: string | null }>;

  /** Opnieuw versturen: nieuw token, nieuwe teller (spec §3.3 stap 3). */
  verstuurOpnieuw(
    vveId: bigint,
    uitnodigingId: bigint,
    doorPersoonId: bigint,
  ): Promise<{ token: string | null }>;

  lijst(vveId: bigint): Promise<UitnodigingenOverzicht>;

  /**
   * Registreer/activatieflow: het token uit de mail inwisselen voor een
   * account met wachtwoord (of, bij een bestaand persoon, alleen de koppeling
   * bevestigen). Werkt buiten de tenant: de uitnodiging is zelf de context.
   */
  registreer(
    token: string,
    wachtwoord: string,
  ): Promise<{
    persoonId: bigint;
    vveId: bigint;
    eenheidId: bigint | null;
  }>;
}

export interface UitnodigingenServiceConfig {
  readonly db: NodePgDatabase;
  readonly mail: MailServiceInterface;
  readonly klok: Klok;
  /** Basis van de registratielink; de token-tekst wordt erachter geplakt. */
  readonly registratieBasis: string;
}

export function maakUitnodigingenService(config: UitnodigingenServiceConfig): UitnodigingenService {
  const { db, mail, klok, registratieBasis } = config;
  const audit = maakAuditService({ db });

  function vandaag(): string {
    return klok.nu().toISOString().slice(0, 10);
  }

  function geldigEmail(waarde: unknown): string {
    const tekst = typeof waarde === 'string' ? waarde.trim() : '';
    if (tekst === '') throw new InvoerFout('Veld "email" is verplicht.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tekst)) {
      throw new InvoerFout('Dat is geen geldig e-mailadres.');
    }
    return tekst;
  }

  function hashVan(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /** Zoekt of maakt de persoon bij dit e-mailadres; retourneert id + 'bestaat al'. */
  async function persoonZoekenOfAanmaken(
    tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
    email: string,
  ): Promise<{ id: bigint; bestaand: boolean }> {
    const [bestaand] = await tx
      .select({ id: persoon.id })
      .from(persoon)
      .where(eq(persoon.email, email))
      .limit(1);
    if (bestaand !== undefined) return { id: bestaand.id, bestaand: true };
    const [nieuw] = await tx
      .insert(persoon)
      .values({ email, achternaam: email.split('@')[0] ?? 'Onbekend' })
      .returning({ id: persoon.id });
    if (nieuw === undefined) throw new Error('persoon-insert leverde geen id op');
    return { id: nieuw.id, bestaand: false };
  }

  /**
   * Koppelt de persoon als eigenaar aan de eenheid, in een tenant-transactie
   * (RLS). Een bestaande koppeling (zelfde persoon, nog lopende periode) is
   * idempotent: geen dubbele rij.
   */
  async function koppelEigenaar(
    vveId: bigint,
    eenheidId: bigint,
    persoonId: bigint,
  ): Promise<void> {
    await inTenantTransactie(db, vveId, async (tx) => {
      const [lopend] = await tx
        .select({ id: eigenaarschap.id })
        .from(eigenaarschap)
        .where(
          and(
            eq(eigenaarschap.wooneenheidId, eenheidId),
            eq(eigenaarschap.persoonId, persoonId),
            sql`${eigenaarschap.periode} @> CURRENT_DATE`,
          ),
        )
        .limit(1);
      if (lopend !== undefined) return;
      await tx.insert(eigenaarschap).values({
        vveId,
        wooneenheidId: eenheidId,
        persoonId,
        aandeelPromille: 1000,
        // Eerste koppeling = primair contact; daar kan V03 nog op sturen.
        isPrimairContact: true,
        periode: `[${vandaag()},)`,
      });
    });
  }

  /** De registratielink-mail; gevoelig — de tekst wordt na verzending gewist. */
  async function stuurRegistratielink(vveId: bigint, email: string, token: string): Promise<void> {
    const link = `${registratieBasis}?token=${token}`;
    await mail.zetInWachtrij({
      vveId,
      ontvangerEmail: email,
      onderwerp: 'Uitnodiging — registratie VvE-beheer',
      tekst: `Je bent uitgenodigd voor de VvE-beheerapplicatie.\n\nRegistreer je account via deze link (30 dagen geldig, één keer bruikbaar):\n\n${link}\n\nKom je er niet uit? Stuur een bericht naar je beheerder.`,
      gevoelig: true,
      categorie: 'app',
    });
  }

  /** De "u bent toegevoegd"-melding voor een persoon die al een account had. */
  async function stuurToegevoegdMelding(vveId: bigint, email: string, naam: string): Promise<void> {
    const [vveRij] = await db
      .select({ naam: vve.naam })
      .from(vve)
      .where(eq(vve.id, vveId))
      .limit(1);
    const vveNaam = vveRij?.naam ?? 'de VvE';
    await mail.zetInWachtrij({
      vveId,
      ontvangerEmail: email,
      onderwerp: `Toegevoegd aan ${vveNaam}`,
      tekst: `Beste ${naam},\n\nJe bent gekoppeld als eigenaar in ${vveNaam} binnen de VvE-beheerapplicatie. Log in met je bestaande account om je gegevens te bekijken.\n\nMet vriendelijke groet,\nhet beheer`,
      gevoelig: false,
      categorie: 'app',
    });
  }

  return {
    async nodigUit(vveId, verzoek, doorPersoonId) {
      const email = geldigEmail(verzoek.email);

      // De eenheid moet in deze VvE bestaan (tenant-verificatie vóór alles).
      const [eenheid] = await db
        .select({ id: wooneenheid.id, code: wooneenheid.code })
        .from(wooneenheid)
        .where(and(eq(wooneenheid.id, verzoek.eenheidId ?? 0n), eq(wooneenheid.vveId, vveId)))
        .limit(1);
      if (eenheid === undefined) {
        throw new NietGevondenFout('Wooneenheid niet gevonden in deze VvE.');
      }

      // Bestaat het adres al als persoon? Dan direct koppelen, geen token (§3.3 stap 2).
      const [bestaandPersoon] = await db
        .select({ id: persoon.id })
        .from(persoon)
        .where(eq(persoon.email, email))
        .limit(1);

      if (bestaandPersoon !== undefined && verzoek.rol === 'eigenaar') {
        await koppelEigenaar(vveId, eenheid.id, bestaandPersoon.id);
        await stuurToegevoegdMelding(vveId, email, email.split('@')[0] ?? 'eigenaar');
        await audit.registreer({
          vveId,
          persoonId: doorPersoonId,
          gebeurtenis: 'uitnodiging.bestaand_koppel',
          categorie: 'app',
          onderwerpTabel: 'wooneenheid',
          onderwerpId: eenheid.id,
          details: { email },
        });
        return { uitnodigingId: 0n, bestaandPersoon: true, token: null };
      }

      // Nieuw adres: uitnodiging met opak token + registratielink (gevoelig).
      const token = randomBytes(32).toString('hex');
      const nu = klok.nu();
      const verlooptOp = new Date(nu.getTime() + GELDIGHEID_DAGEN * DAG_MS);
      const [rij] = await db
        .insert(uitnodiging)
        .values({
          vveId,
          wooneenheidId: eenheid.id,
          email,
          rol: verzoek.rol === 'bewoner' ? 'bewoner' : 'eigenaar',
          tokenHash: hashVan(token),
          verlooptOp,
          verzondenOp: nu,
          aantalVerzonden: 1,
          aangemaaktDoor: doorPersoonId,
        })
        .returning({ id: uitnodiging.id });
      if (rij === undefined) throw new Error('uitnodiging-insert leverde geen id op');

      await stuurRegistratielink(vveId, email, `${registratieBasis}?token=${token}`);
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'uitnodiging.verstuur',
        categorie: 'app',
        onderwerpTabel: 'uitnodiging',
        onderwerpId: rij.id,
        details: { email, rol: verzoek.rol },
      });
      return { uitnodigingId: rij.id, bestaandPersoon: false, token };
    },

    async verstuurOpnieuw(vveId, uitnodigingId, doorPersoonId) {
      // Alleen rijen van deze tenant (RLS + expliciete WHERE).
      const [rij] = await db
        .select()
        .from(uitnodiging)
        .where(and(eq(uitnodiging.id, uitnodigingId), eq(uitnodiging.vveId, vveId)))
        .limit(1);
      if (rij === undefined) throw new NietGevondenFout('Uitnodiging niet gevonden.');
      if (rij.gebruiktOp !== null) {
        throw new InvoerFout('Deze uitnodiging is al gebruikt.');
      }

      // Nieuw token: de oude link is misschien gelekt of kwijtgeraakt.
      const token = randomBytes(32).toString('hex');
      const nu = klok.nu();
      await db
        .update(uitnodiging)
        .set({
          tokenHash: hashVan(token),
          verlooptOp: new Date(nu.getTime() + GELDIGHEID_DAGEN * DAG_MS),
          verzondenOp: nu,
          aantalVerzonden: rij.aantalVerzonden + 1,
        })
        .where(eq(uitnodiging.id, uitnodigingId));

      await stuurRegistratielink(vveId, rij.email, `${registratieBasis}?token=${token}`);
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'uitnodiging.her_verstuur',
        categorie: 'app',
        onderwerpTabel: 'uitnodiging',
        onderwerpId: uitnodigingId,
        details: { email: rij.email },
      });
      return { token };
    },

    async lijst(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const rijen = await tx
          .select({
            id: uitnodiging.id,
            email: uitnodiging.email,
            rol: uitnodiging.rol,
            eenheidCode: wooneenheid.code,
            verlooptOp: uitnodiging.verlooptOp,
            gebruiktOp: uitnodiging.gebruiktOp,
            aantalVerzonden: uitnodiging.aantalVerzonden,
            verzondenOp: uitnodiging.verzondenOp,
          })
          .from(uitnodiging)
          .leftJoin(wooneenheid, eq(wooneenheid.id, uitnodiging.wooneenheidId))
          .where(eq(uitnodiging.vveId, vveId))
          .orderBy(desc(uitnodiging.id));

        return {
          rijen: rijen.map((r) => ({
            ...r,
            status: r.gebruiktOp === null ? ('uitgenodigd' as const) : ('gebruikt' as const),
          })),
        };
      });
    },

    async registreer(token, wachtwoord) {
      if (typeof wachtwoord !== 'string' || wachtwoord.length < 12) {
        throw new InvoerFout('Het wachtwoord moet minimaal 12 tekens zijn.');
      }
      // De registratie staat bewust zonder TenantGuard: het token ís de
      // context. De hash opzoeken en consumeren moet één ondeelbare
      // handeling zijn, zodat een dubbel aangeboden token de tweede keer
      // als 'al gebruikt' faalt.
      const uitkomst = await db.transaction(async (tx) => {
        const hash = hashVan(token);
        const [rij] = await tx
          .select()
          .from(uitnodiging)
          .where(and(eq(uitnodiging.tokenHash, hash), isNull(uitnodiging.gebruiktOp)))
          .limit(1);
        if (rij === undefined || rij.verlooptOp.getTime() <= klok.nu().getTime()) {
          throw new OngeldigTokenFout();
        }

        // Wachtwoord-hash en persoon worden hier aangemaakt; het wachtwoord
        // beleefd het beoordelingsregime uit F06a/F12 via de hash-functie.
        const { hashWachtwoord, beoordeelWachtwoord } =
          await import('../../gemeenschappelijk/auth/wachtwoord.js');
        const oordeel = beoordeelWachtwoord(wachtwoord);
        if (!oordeel.ok) {
          throw new InvoerFout(oordeel.redenen.join(' '));
        }
        const wachtwoordHash = await hashWachtwoord(wachtwoord);

        // De persoon kan tussentijds zijn aangemaakt (race met een andere
        // uitnodiging): hier opnieuw opzoeken in de transactie.
        const { id: persoonId, bestaand } = await persoonZoekenOfAanmaken(tx, rij.email);
        await tx
          .update(persoon)
          .set({ wachtwoordHash, wachtwoordWijzigenVerplicht: false, actief: true })
          .where(eq(persoon.id, persoonId));

        await tx
          .update(uitnodiging)
          .set({ gebruiktOp: klok.nu() })
          .where(eq(uitnodiging.id, rij.id));

        // Koppeling aan de eenheid: eigenaar krijgt eigenaarschap, bewoner
        // (AC2.6, volgt in latere blokken) wordt voorlopig alleen onthouden.
        if (rij.rol === 'eigenaar') {
          if (rij.wooneenheidId !== null) {
            await tx.insert(eigenaarschap).values({
              vveId: rij.vveId,
              wooneenheidId: rij.wooneenheidId,
              persoonId,
              aandeelPromille: 1000,
              isPrimairContact: true,
              periode: `[${vandaag()},)`,
            });
          }
          await tx.insert(rolToewijzing).values({
            vveId: rij.vveId,
            persoonId,
            rol: 'eigenaar',
            startDatum: vandaag(),
          });
        }

        return { persoonId, vveId: rij.vveId, eenheidId: rij.wooneenheidId, bestaand };
      });

      await audit.registreer({
        vveId: uitkomst.vveId,
        persoonId: uitkomst.persoonId,
        gebeurtenis: 'uitnodiging.registratie',
        categorie: 'beveiliging',
        onderwerpTabel: 'persoon',
        onderwerpId: uitkomst.persoonId,
        details: { eenheidId: uitkomst.eenheidId === null ? null : String(uitkomst.eenheidId) },
      });
      return {
        persoonId: uitkomst.persoonId,
        vveId: uitkomst.vveId,
        eenheidId: uitkomst.eenheidId,
      };
    },
  };
}
