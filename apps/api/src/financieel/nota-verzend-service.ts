/**
 * Nota-verzend-service — blok G07 (spec §6.6 · M13 · AC13.4/AC13.5).
 *
 * De nota van G06 is een vordering; dit blok levert het *bewijsstuk*:
 *
 *   1. `bouwEnBewaar` — bouwt de PDF (nota-pdf.ts) en bewaart de bytes in
 *      `pdf_document`; de nota koppelt erop via `pdf_document_id` (AC13.5).
 *   2. `verzendSerie` — AC13.4: alle open nota's van een periode in één
 *      handeling. Per nota een mail via de F10-wachtrij (met bijlagepad), de
 *      status/verzonden_op bijgewerkt, en een voortgangsrapport met de lijst
 *      eenheden die *per post* gaan (geen e-mail bekend).
 *
 * **Geen dubbele verzending:** de wachtrij-claim (§7.7) voorkomt dubbelt op
 * berichtniveau; hierbovenop slaat `verzendSerie` nota's met `verzonden_op`
 * over, binnen dezelfde tenant-transactie. Eén nota = één bewijs-PDF: bij
 * herbouw komt er een nieuw document en verhuist de koppeling (de oude rij
 * blijft als historie — de bytes van het moment van verzending bewijzen).
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { nota, notaRegel } from '../database/schema/nota.js';
import { pdfDocument } from '../database/schema/pdf-document.js';
import { persoon } from '../database/schema/persoon.js';
import { vve } from '../database/schema/vve.js';
import { wooneenheid } from '../database/schema/wooneenheid.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { MailService } from '../gemeenschappelijk/mail/mail-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';
import { bouwNotaPdf, type PdfRegel } from './nota-pdf.js';

export interface VerzendUitkomst {
  readonly aantalVerzonden: number;
  readonly aantalPost: number;
  /** Eenheden zonder e-mail — per post (AC13.4). */
  readonly postlijst: readonly string[];
}

export interface NotaVerzendService {
  /** Bouwt (of vervangt) de PDF van één nota en koppelt haar (AC13.5). */
  bouwEnBewaar(vveId: bigint, notaId: bigint, doorPersoonId: bigint): Promise<{ id: bigint }>;
  /** Levert de PDF-bytes van één nota (dossier/download, AC13.5). */
  leverPdf(vveId: bigint, notaId: bigint): Promise<{ bytes: Buffer; bestandsnaam: string }>;
  /** AC13.4: alle open nota's van een periode in één handeling. */
  verzendSerie(vveId: bigint, periodeVan: string, doorPersoonId: bigint): Promise<VerzendUitkomst>;
}

export function maakNotaVerzendService(config: {
  readonly db: NodePgDatabase;
  readonly mail: MailService;
}): NotaVerzendService {
  const { db, mail } = config;
  const audit = maakAuditService({ db });

  /** Haalt de nota (met eenheid en VvE-naam) binnen de tenant op. */
  async function notaRij(
    vveId: bigint,
    notaId: bigint,
  ): Promise<{
    id: bigint;
    nummer: string;
    betalingskenmerk: string;
    eenheidCode: string;
    periodeVan: string | null;
    periodeTot: string | null;
    factuurdatum: string;
    vervaldatum: string;
    betaalwijze: string;
    verzondenOp: Date | null;
    vveNaam: string;
  }> {
    const rijen = await inTenantTransactie(db, vveId, async (tx) =>
      tx
        .select({
          id: nota.id,
          nummer: nota.nummer,
          betalingskenmerk: nota.betalingskenmerk,
          code: wooneenheid.code,
          periodeVan: nota.periodeVan,
          periodeTot: nota.periodeTot,
          factuurdatum: nota.factuurdatum,
          vervaldatum: nota.vervaldatum,
          betaalwijze: nota.betaalwijze,
          verzondenOp: nota.verzondenOp,
          vveNaam: vve.naam,
        })
        .from(nota)
        .innerJoin(wooneenheid, eq(wooneenheid.id, nota.wooneenheidId))
        .innerJoin(vve, eq(vve.id, nota.vveId))
        .where(and(eq(nota.vveId, vveId), eq(nota.id, notaId)))
        .limit(1),
    );
    const rij = rijen[0];
    if (rij === undefined) throw new NietGevondenFout('Nota niet gevonden.');
    return {
      id: rij.id,
      nummer: rij.nummer,
      betalingskenmerk: rij.betalingskenmerk,
      eenheidCode: rij.code,
      periodeVan: rij.periodeVan,
      periodeTot: rij.periodeTot,
      factuurdatum: rij.factuurdatum,
      vervaldatum: rij.vervaldatum,
      betaalwijze: rij.betaalwijze,
      verzondenOp: rij.verzondenOp,
      vveNaam: rij.vveNaam,
    };
  }

  /** De specificatieregels van één nota (PDF-invoer). */
  async function regelsVan(vveId: bigint, notaId: bigint): Promise<readonly PdfRegel[]> {
    return inTenantTransactie(db, vveId, async (tx) =>
      tx
        .select({
          omschrijving: notaRegel.omschrijving,
          bedragCent: notaRegel.bedragCent,
          isReservefonds: notaRegel.isReservefonds,
        })
        .from(notaRegel)
        .innerJoin(nota, eq(nota.id, notaRegel.notaId))
        .where(and(eq(nota.vveId, vveId), eq(notaRegel.notaId, notaId))),
    );
  }

  function periodeLabel(rij: { periodeVan: string | null; periodeTot: string | null }): string {
    return rij.periodeVan !== null && rij.periodeTot !== null
      ? `Periode ${rij.periodeVan} t/m ${rij.periodeTot}`
      : 'Losse nota';
  }

  return {
    async bouwEnBewaar(vveId, notaId, doorPersoonId) {
      const rij = await notaRij(vveId, notaId);
      const regels = await regelsVan(vveId, notaId);
      const bytes = bouwNotaPdf({
        vveNaam: rij.vveNaam,
        nummer: rij.nummer,
        betalingskenmerk: rij.betalingskenmerk,
        eenheidCode: rij.eenheidCode,
        periodeLabel: periodeLabel(rij),
        factuurdatum: rij.factuurdatum,
        vervaldatum: rij.vervaldatum,
        betaalwijze: rij.betaalwijze,
        regels,
      });
      const bestandsnaam = `nota-${rij.nummer}.pdf`;

      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [docRij] = await tx
          .insert(pdfDocument)
          .values({
            vveId,
            soort: 'nota',
            bestandsnaam,
            inhoud: bytes,
            grootteBytes: bytes.length,
          })
          .returning({ id: pdfDocument.id });
        if (docRij === undefined) throw new Error('pdf-insert leverde geen id op');
        await tx
          .update(nota)
          .set({ pdfDocumentId: docRij.id })
          .where(and(eq(nota.vveId, vveId), eq(nota.id, notaId)));
        return docRij.id;
      });

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'nota.pdf_gebouwd',
        categorie: 'financieel',
        onderwerpTabel: 'nota',
        onderwerpId: notaId,
        details: { documentId: String(id), bestandsnaam, grootte: bytes.length },
      });
      return { id };
    },

    async leverPdf(vveId, notaId) {
      const docRijen = await inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({ inhoud: pdfDocument.inhoud, bestandsnaam: pdfDocument.bestandsnaam })
          .from(pdfDocument)
          .innerJoin(nota, eq(nota.pdfDocumentId, pdfDocument.id))
          .where(and(eq(nota.vveId, vveId), eq(nota.id, notaId)))
          .limit(1),
      );
      const doc = docRijen[0];
      if (doc === undefined) throw new NietGevondenFout('Nota heeft nog geen PDF; bouw die eerst.');
      return { bytes: Buffer.from(doc.inhoud), bestandsnaam: doc.bestandsnaam };
    },

    async verzendSerie(vveId, periodeVan, doorPersoonId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodeVan)) {
        throw new InvoerFout('Veld "periodeVan" moet de vorm YYYY-MM-DD hebben.');
      }

      const { aantalVerzonden, aantalPost, postlijst } = await inTenantTransactie(
        db,
        vveId,
        async (tx) => {
          // De open nota's van de periode, met het e-mailadres van de debiteur
          // (AC13.4). Eenheid zonder e-mail → per post.
          const rijen = await tx
            .select({
              notaId: nota.id,
              nummer: nota.nummer,
              kenmerk: nota.betalingskenmerk,
              eenheidCode: wooneenheid.code,
              periodeVan: nota.periodeVan,
              periodeTot: nota.periodeTot,
              factuurdatum: nota.factuurdatum,
              vervaldatum: nota.vervaldatum,
              betaalwijze: nota.betaalwijze,
              verzondenOp: nota.verzondenOp,
              email: persoon.email,
              communicatie: persoon.communicatieWijze,
              vveNaam: vve.naam,
            })
            .from(nota)
            .innerJoin(wooneenheid, eq(wooneenheid.id, nota.wooneenheidId))
            .innerJoin(vve, eq(vve.id, nota.vveId))
            .innerJoin(persoon, eq(persoon.id, nota.persoonId))
            .where(
              and(eq(nota.vveId, vveId), eq(nota.periodeVan, periodeVan), eq(nota.status, 'open')),
            );

          let verzondenTeller = 0;
          let postTeller = 0;
          const postEenheiden: string[] = [];
          for (const rij of rijen) {
            if (rij.verzondenOp !== null) continue; // al verzonden: nooit dubbelt
            const regels = await regelsVan(vveId, rij.notaId);
            const bytes = bouwNotaPdf({
              vveNaam: rij.vveNaam,
              nummer: rij.nummer,
              betalingskenmerk: rij.kenmerk,
              eenheidCode: rij.eenheidCode,
              periodeLabel: periodeLabel(rij),
              factuurdatum: rij.factuurdatum,
              vervaldatum: rij.vervaldatum,
              betaalwijze: rij.betaalwijze,
              regels,
            });
            const bestandsnaam = `nota-${rij.nummer}.pdf`;

            if (rij.communicatie === 'post' || rij.email === '') {
              // Per post (AC13.4): wél het PDF-document bewaren als bewijs.
              postTeller += 1;
              postEenheiden.push(rij.eenheidCode);
            } else {
              await mail.zetInWachtrij({
                vveId,
                ontvangerEmail: rij.email,
                onderwerp: `Nota ${rij.nummer} — ${rij.vveNaam}`,
                tekst: `Uw nota ${rij.nummer} met betalingskenmerk ${rij.kenmerk} is bijgevoegd (PDF). Vervaldatum: ${rij.vervaldatum}.`,
                bijlagePad: `notas/${bestandsnaam}`,
                categorie: 'financieel',
              });
              verzondenTeller += 1;
            }

            // PDF bewaren en nota markeren — één handeling per nota.
            const [docRij] = await tx
              .insert(pdfDocument)
              .values({
                vveId,
                soort: 'nota',
                bestandsnaam,
                inhoud: bytes,
                grootteBytes: bytes.length,
              })
              .returning({ id: pdfDocument.id });
            if (docRij === undefined) throw new Error('pdf-insert leverde geen id op');
            await tx
              .update(nota)
              .set({ pdfDocumentId: docRij.id, verzondenOp: new Date() })
              .where(and(eq(nota.vveId, vveId), eq(nota.id, rij.notaId)));
          }
          return {
            aantalVerzonden: verzondenTeller,
            aantalPost: postTeller,
            postlijst: postEenheiden,
          };
        },
      );

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'nota.verzend_serie',
        categorie: 'financieel',
        onderwerpTabel: 'nota',
        onderwerpId: 0n,
        details: { periode: periodeVan, aantalVerzonden, aantalPost },
      });
      return { aantalVerzonden, aantalPost, postlijst };
    },
  };
}
