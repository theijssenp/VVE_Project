/**
 * Bankafschriften inlezen — blok B02 (spec §10, AC7.1–7.3, tests #11–12).
 *
 * De parser zit in `packages/domein/bank` en kent geen database; deze service
 * zet zijn uitkomst weg en bewaakt de twee regels die een import betrouwbaar
 * maken:
 *
 *   **AC7.2 — duplicaatdetectie.** Van elke post wordt een sha256 bewaard over
 *   rekening, boekdatum, bedrag, tegenrekening, omschrijving en referentie. Dat
 *   is een UNIQUE-constraint op (vve_id, duplicaat_hash), geen controle in
 *   code: hetzelfde bestand tweemaal inlezen voegt niets toe omdat de database
 *   het niet toelaat, niet omdat wij eraan dachten. Test #11.
 *
 *   **AC7.3 — saldocontinuïteit.** Het beginsaldo van dit bestand hoort het
 *   eindsaldo van de vorige import te zijn. Wijkt dat af, dan is er een
 *   afschrift overgeslagen. De import gaat wél door — de posten zijn echt en
 *   weggooien helpt niemand — maar het gat wordt vastgelegd en teruggemeld,
 *   zodat de beheerder ziet dat er iets mist en hoeveel. Test #12.
 *
 * **IBAN's.** Tegenrekeningen zijn persoonsgegevens; die gaan als §6.2-drieluik
 * de database in en nooit in platte tekst (kritieke volgorde: B01 vóór B02).
 * Een tegenrekening die niet als IBAN te lezen is — buitenlandse posten, of een
 * kostenpost van de bank zelf — wordt overgeslagen in plaats van geweigerd: de
 * mutatie zelf is wél echt.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { leesCamt053, type Bankmutatie as GeparsteMutatie } from '@vve/domein';

import { bankImport, bankmutatie, bankrekening } from '../database/schema/bank.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from '../financieel/boekhouding.js';
import {
  beveiligIban,
  ibanHmac,
  isGeldigIban,
  laadIbanSleutels,
  normaliseerIban,
  type IbanSleutels,
} from './iban-versleuteling.js';

export interface ImportUitkomst {
  readonly importId: bigint;
  readonly bankrekeningId: bigint;
  readonly afschriftId: string | null;
  readonly aantalPosten: number;
  readonly aantalNieuw: number;
  readonly aantalDuplicaat: number;
  readonly beginsaldoCent: number;
  readonly eindsaldoCent: number;
  /** AC7.3: null als het aansloot, anders het verschil in centen. */
  readonly continuiteitGatCent: number | null;
  /** Sluit het bestand intern (beginsaldo + posten == eindsaldo)? */
  readonly afschriftSluit: boolean;
}

export interface BankimportService {
  /** Leest een CAMT.053-bestand in voor de VvE van de sessie. */
  importeerCamt053(
    vveId: bigint,
    xml: string,
    opties: { bestandsnaam?: string | null },
    doorPersoonId: bigint,
  ): Promise<readonly ImportUitkomst[]>;
}

/** sha256 over de samengestelde sleutel uit de parser (AC7.2). */
export function duplicaatHash(sleutel: string): Buffer {
  return createHash('sha256').update(sleutel, 'utf8').digest();
}

export function maakBankimportService(config: {
  readonly db: NodePgDatabase;
  readonly sleutels?: IbanSleutels;
}): BankimportService {
  const { db } = config;
  const audit = maakAuditService({ db });

  return {
    async importeerCamt053(vveId, xml, opties, doorPersoonId) {
      const sleutels = config.sleutels ?? laadIbanSleutels();
      const afschriften = leesCamt053(xml);
      const uitkomsten: ImportUitkomst[] = [];

      for (const afschrift of afschriften) {
        const eigenIban = normaliseerIban(afschrift.rekeningIban);
        if (!isGeldigIban(eigenIban)) {
          throw new InvoerFout(
            `Het afschrift noemt een onleesbare IBAN: ${afschrift.rekeningIban}.`,
          );
        }
        const hmac = ibanHmac(eigenIban, sleutels);

        const uit = await inTenantTransactie(db, vveId, async (tx) => {
          // 1. De eigen rekening moet bekend zijn. Automatisch aanmaken zou
          //    betekenen dat een verkeerd bestand stilletjes een nieuwe
          //    rekening opvoert; liever hoorbaar weigeren.
          const [rekening] = await tx
            .select({
              id: bankrekening.id,
              laatsteSaldoCent: bankrekening.laatsteSaldoCent,
            })
            .from(bankrekening)
            .where(and(eq(bankrekening.vveId, vveId), eq(bankrekening.ibanHmac, hmac)))
            .limit(1);
          if (rekening === undefined) {
            throw new NietGevondenFout(
              'Deze bankrekening is niet bekend bij deze VvE; voer hem eerst op.',
            );
          }

          // 2. AC7.3 — sluit dit bestand aan op het vorige?
          const gat =
            rekening.laatsteSaldoCent === null
              ? null
              : afschrift.beginsaldoCent - rekening.laatsteSaldoCent;
          const continuiteitGat = gat === null || gat === 0 ? null : gat;

          const [importRij] = await tx
            .insert(bankImport)
            .values({
              vveId,
              bankrekeningId: rekening.id,
              formaat: 'camt053',
              bestandsnaam: opties.bestandsnaam ?? null,
              afschriftId: afschrift.afschriftId,
              beginsaldoCent: afschrift.beginsaldoCent,
              eindsaldoCent: afschrift.eindsaldoCent,
              beginsaldoDatum: afschrift.beginsaldoDatum,
              eindsaldoDatum: afschrift.eindsaldoDatum,
              aantalPosten: afschrift.mutaties.length,
              continuiteitGatCent: continuiteitGat,
              doorPersoonId,
            })
            .returning({ id: bankImport.id });
          if (importRij === undefined) throw new Error('bank_import leverde geen id op');

          // 3. De posten, met de UNIQUE als duplicaatbewaking.
          let nieuw = 0;
          for (const m of afschrift.mutaties) {
            const tegen = tegenrekeningVelden(m, sleutels);
            const rijen = await tx
              .insert(bankmutatie)
              .values({
                vveId,
                bankrekeningId: rekening.id,
                bankImportId: importRij.id,
                boekdatum: m.boekdatum,
                valutadatum: m.valutadatum,
                bedragCent: m.bedragCent,
                munt: m.munt,
                tegenpartijNaam: m.tegenpartijNaam,
                omschrijving: m.omschrijving,
                eindTotEindId: m.eindToEindId,
                bankreferentie: m.bankreferentie,
                volgnummer: m.volgnummer,
                duplicaatHash: duplicaatHash(m.duplicaatSleutel),
                ...tegen,
              })
              // Hetzelfde bestand nog eens: de rij bestaat al, en dat is geen
              // fout maar het verwachte antwoord (test #11).
              .onConflictDoNothing({
                target: [bankmutatie.vveId, bankmutatie.duplicaatHash],
              })
              .returning({ id: bankmutatie.id });
            if (rijen.length > 0) nieuw += 1;
          }

          const duplicaat = afschrift.mutaties.length - nieuw;
          await tx
            .update(bankImport)
            .set({ aantalNieuw: nieuw, aantalDuplicaat: duplicaat })
            .where(eq(bankImport.id, importRij.id));

          // 4. Het eindsaldo wordt de nieuwe maatstaf voor de volgende import.
          //    Alleen als dit afschrift later is dan wat we al hadden: een oud
          //    bestand nalezen mag de stand niet terugdraaien.
          const [huidige] = await tx
            .select({
              datum: bankrekening.laatsteSaldoDatum,
            })
            .from(bankrekening)
            .where(eq(bankrekening.id, rekening.id))
            .limit(1);
          const nieuwerDanBekend =
            huidige?.datum === null ||
            huidige?.datum === undefined ||
            afschrift.eindsaldoDatum === null ||
            afschrift.eindsaldoDatum >= huidige.datum;
          if (nieuwerDanBekend) {
            await tx
              .update(bankrekening)
              .set({
                laatsteSaldoCent: afschrift.eindsaldoCent,
                laatsteSaldoDatum: afschrift.eindsaldoDatum,
              })
              .where(eq(bankrekening.id, rekening.id));
          }

          await audit.registreer({
            vveId,
            persoonId: doorPersoonId,
            gebeurtenis: 'bank.import',
            categorie: 'financieel',
            onderwerpTabel: 'bank_import',
            onderwerpId: importRij.id,
            details: {
              afschriftId: afschrift.afschriftId,
              aantalPosten: afschrift.mutaties.length,
              aantalNieuw: nieuw,
              aantalDuplicaat: duplicaat,
              continuiteitGatCent: continuiteitGat,
            },
          });

          const som = afschrift.mutaties.reduce((s, x) => s + x.bedragCent, 0);
          return {
            importId: importRij.id,
            bankrekeningId: rekening.id,
            afschriftId: afschrift.afschriftId,
            aantalPosten: afschrift.mutaties.length,
            aantalNieuw: nieuw,
            aantalDuplicaat: duplicaat,
            beginsaldoCent: afschrift.beginsaldoCent,
            eindsaldoCent: afschrift.eindsaldoCent,
            continuiteitGatCent: continuiteitGat,
            afschriftSluit: afschrift.beginsaldoCent + som === afschrift.eindsaldoCent,
          } satisfies ImportUitkomst;
        });

        uitkomsten.push(uit);
      }

      return uitkomsten;
    },
  };
}

/**
 * Het §6.2-drieluik voor de tegenrekening, of lege velden als er geen leesbare
 * IBAN is. Een bankkostenpost heeft geen tegenrekening; die mutatie is daarom
 * niet minder echt.
 */
function tegenrekeningVelden(
  m: GeparsteMutatie,
  sleutels: IbanSleutels,
): {
  tegenrekeningVersleuteld: Buffer | null;
  tegenrekeningHmac: Buffer | null;
  tegenrekeningMasker: string | null;
} {
  if (m.tegenrekeningIban === null) {
    return {
      tegenrekeningVersleuteld: null,
      tegenrekeningHmac: null,
      tegenrekeningMasker: null,
    };
  }
  const genormaliseerd = normaliseerIban(m.tegenrekeningIban);
  if (!isGeldigIban(genormaliseerd)) {
    return {
      tegenrekeningVersleuteld: null,
      tegenrekeningHmac: null,
      // Wat niet als IBAN te lezen is, blijft wel zichtbaar als tekst in het
      // masker — anders raakt de beheerder het spoor kwijt bij een
      // buitenlandse of afwijkende rekening.
      tegenrekeningMasker: m.tegenrekeningIban.slice(0, 8),
    };
  }
  const drieluik = beveiligIban(genormaliseerd, sleutels);
  return {
    tegenrekeningVersleuteld: drieluik.versleuteld,
    tegenrekeningHmac: drieluik.hmac,
    tegenrekeningMasker: drieluik.masker,
  };
}
