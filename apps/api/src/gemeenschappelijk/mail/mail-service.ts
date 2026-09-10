/**
 * Mailwachtrij en verzendworker — F10 (spec §7.7, §13.2/§13.5).
 *
 * Alle uitgaande mail via de wachtrij: een falende SMTP mag nooit een
 * gebruikersactie laten mislukken. De worker (`verwerkWachtrij`) haalt
 * wachtende berichten op, stuurt met nodemailer, en rekent met exponentiële
 * backoff bij fouten (max 5 pogingen, §7.7).
 *
 * pg-boss pland de terugkerende taken (mail:verwerk en audit:verifieer_keten,
 * §7.7); de worker zelf is een gewone functie die de taak aanroept — zodat de
 * tests de verzending deterministisch kunnen draaien zonder een scheduler.
 */

import { and, asc, eq, lte, or, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { mailWachtrij } from '../../database/schema/mail.js';

/** Maximale pogingen vóór `mislukt` (§7.7 mail:verwerk). */
export const MAX_POGINGEN = 5;

/** Vervangt de berichttekst van een gevoelig bericht na geslaagde verzending. */
export const GEWIST_MARKERING = '[inhoud gewist na verzending — bevatte een geheim]';
/** Basisvertraging voor de exponentiële backoff: 1, 2, 4, 8, 16 minuten. */
const BACKOFF_BASIS_MS = 60_000;

export interface MailInvoer {
  /**
   * Bericht bevat een geheim (gegenereerd wachtwoord, instellink). De tekst
   * wordt gewist zodra de aflevering is geslaagd: zonder dat blijft het geheim
   * twee jaar in de wachtrij staan (§8.3) en in elke back-up. De regel zelf
   * blijft, zodat het bewijs dát er iets is verstuurd bewaard blijft.
   */
  readonly gevoelig?: boolean;
  readonly vveId: bigint | null;
  readonly ontvangerEmail: string;
  readonly antwoordAdres?: string | null;
  readonly onderwerp: string;
  readonly tekst: string;
  readonly isHtml?: boolean;
  readonly bijlagePad?: string | null;
  readonly categorie?: 'app' | 'financieel' | 'beveiliging';
  /** Wanneer uiterlijk verzonden moet worden; onbepaald = zo snel mogelijk. */
  readonly afleverVoor?: Date | null;
}

export interface MailVerzender {
  /** De SMTP-transportfunctie — injecteerbaar zodat tests niets versturen. */
  verzend(bericht: {
    readonly ontvangerEmail: string;
    readonly antwoordAdres: string | null;
    readonly onderwerp: string;
    readonly tekst: string;
    readonly isHtml: boolean;
    readonly bijlagePad: string | null;
  }): Promise<void>;
}

export interface MailService {
  /** Zet een bericht in de wachtrij (status 'wachtend'). Faalt nooit op SMTP. */
  zetInWachtrij(bericht: MailInvoer): Promise<{ id: bigint }>;
  /**
   * Verwerkt de wachtende berichten tot het venster leeg is of `maximum`
   * berichten zijn afgehandeld. Retourneert de tellingen; SMTP-fouten lopen
   * via de backoff, geen throw naar de beller (behalve een fout in de
   * database zelf).
   */
  verwerkWachtrij(opties?: { readonly maximaal?: number }): Promise<{
    verzonden: number;
    mislukt: number;
    resterend: number;
  }>;
}

export function maakMailService(config: {
  readonly db: NodePgDatabase;
  readonly verzender: MailVerzender;
}): MailServiceInterface {
  const { db, verzender } = config;
  const klok = new Date();

  return {
    async zetInWachtrij(bericht) {
      const [rij] = await db
        .insert(mailWachtrij)
        .values({
          vveId: bericht.vveId,
          ontvangerEmail: bericht.ontvangerEmail,
          antwoordAdres: bericht.antwoordAdres ?? null,
          onderwerp: bericht.onderwerp,
          tekst: bericht.tekst,
          isHtml: bericht.isHtml ?? false,
          gevoelig: bericht.gevoelig ?? false,
          bijlagePad: bericht.bijlagePad ?? null,
          categorie: bericht.categorie ?? 'app',
          status: 'wachtend',
          afleverVoor: bericht.afleverVoor ?? null,
        })
        .returning({ id: mailWachtrij.id });
      if (rij === undefined) {
        throw new Error('mail_wachtrij-insert leverde geen rij op');
      }
      return { id: rij.id };
    },

    async verwerkWachtrij(opties) {
      const maximum = opties?.maximaal ?? 50;
      const nu = new Date();
      // Wachtende berichten waarvan de aflevertijd is verstreken (of ontbreekt):
      const wachtend = await db
        .select()
        .from(mailWachtrij)
        .where(
          and(
            eq(mailWachtrij.status, 'wachtend'),
            or(isNull(mailWachtrij.afleverVoor), lte(mailWachtrij.afleverVoor, nu)),
          ),
        )
        .orderBy(asc(mailWachtrij.id))
        .limit(maximum);

      let verzonden = 0;
      let mislukt = 0;
      for (const rij of wachtend) {
        //claim: status 'bezig' zodat een overlappende run niet dubbelt (§7.7).
        const [geclaimdeRij] = await db
          .update(mailWachtrij)
          .set({ status: 'bezig', laatstePogingOp: klok })
          .where(and(eq(mailWachtrij.id, rij.id), eq(mailWachtrij.status, 'wachtend')))
          .returning({ id: mailWachtrij.id, isHtml: mailWachtrij.isHtml });
        if (geclaimdeRij === undefined) {
          continue; // een andere run was sneller
        }
        try {
          await verzender.verzend({
            ontvangerEmail: rij.ontvangerEmail,
            antwoordAdres: rij.antwoordAdres,
            onderwerp: rij.onderwerp,
            tekst: rij.tekst,
            isHtml: rij.isHtml,
            bijlagePad: rij.bijlagePad,
          });
          await db
            .update(mailWachtrij)
            .set({
              status: 'verzonden',
              foutmelding: null,
              // Geheimen verdwijnen na aflevering; de regel blijft als bewijs.
              ...(rij.gevoelig ? { tekst: GEWIST_MARKERING } : {}),
            })
            .where(eq(mailWachtrij.id, rij.id));
          verzonden += 1;
        } catch (fout: unknown) {
          const pogingen = rij.aantalPogingen + 1;
          const melding = fout instanceof Error ? fout.message : String(fout);
          if (pogingen >= MAX_POGINGEN) {
            await db
              .update(mailWachtrij)
              .set({
                status: 'mislukt',
                aantalPogingen: pogingen,
                laatstePogingOp: klok,
                foutmelding: melding,
              })
              .where(eq(mailWachtrij.id, rij.id));
            mislukt += 1;
          } else {
            // Exponentiële backoff: het bericht gaat terug naar 'wachtend' met
            // een aflever_vóór in de toekomst (basis^pogingen minuten).
            const vertraging = BACKOFF_BASIS_MS * Math.pow(2, pogingen - 1);
            await db
              .update(mailWachtrij)
              .set({
                status: 'wachtend',
                aantalPogingen: pogingen,
                laatstePogingOp: klok,
                foutmelding: melding,
                afleverVoor: new Date(Date.now() + vertraging),
              })
              .where(eq(mailWachtrij.id, rij.id));
          }
        }
      }
      const resterend = await db
        .select({ id: mailWachtrij.id })
        .from(mailWachtrij)
        .where(eq(mailWachtrij.status, 'wachtend'));
      return { verzonden, mislukt, resterend: resterend.length };
    },
  };
}

export interface MailServiceInterface {
  zetInWachtrij(bericht: MailInvoer): Promise<{ id: bigint }>;
  verwerkWachtrij(opties?: { maximaal?: number }): Promise<{
    verzonden: number;
    mislukt: number;
    resterend: number;
  }>;
}
