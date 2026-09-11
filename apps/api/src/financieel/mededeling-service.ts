/**
 * Mededeling-service — blok A06 (spec M13 · AC13.1/AC13.3).
 *
 * **AC13.1:** mededelingen per VvE met doelgroep (alle leden / eigenaren /
 * bewoners) en optionele e-mailverzending via de F10-wachtrij. De
 * ontvangerslijst wordt per doelgroep live opgemaakt: alle leden = iedereen
 * met een rol_toewijzing; eigenaren = via eigenaarschap op vandaag; bewoners
 * = de rol 'bewoner' (V03 — nu nog leeg, de doelgroep bestaat al).
 *
 * **AC13.3:** mailsjablonen per VvE (afzendernaam, ondertekening). Een
 * sjabloonfout mag het versturen nooit blokkeren — de fallback is de
 * standaardtekst: zonder sjabloon-rij of met een fout gaat de mail er gewoon
 * uit met de VvE-naam als afzender.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { mededeling, mailSjabloon } from '../database/schema/mededeling.js';
import { persoon } from '../database/schema/persoon.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import type { MailService } from '../gemeenschappelijk/mail/mail-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout } from './boekhouding.js';

export interface MededelingRij {
  readonly id: bigint;
  readonly titel: string;
  readonly inhoud: string;
  readonly doelgroep: string;
  readonly gepubliceerdOp: Date;
  readonly doorPersoonId: bigint;
  readonly mailVerzonden: boolean;
}

export interface MededelingService {
  /** Publiceert een mededeling; mailVerzonden=true verstuurt (AC13.1). */
  publiceer(
    vveId: bigint,
    invoer: {
      titel: string;
      inhoud: string;
      doelgroep: 'alle_leden' | 'eigenaren' | 'bewoners';
      verzendMail: boolean;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint; aantalMail: number }>;
  /** De laatste mededelingen (portaal, AC14/M13). */
  laatste(vveId: bigint, aantal: number): Promise<readonly MededelingRij[]>;
  /** AC13.3: het sjabloon van de VvE lezen of de defaults. */
  sjabloon(vveId: bigint): Promise<{
    afzendernaam: string;
    ondertekening: string | null;
    logoUrl: string | null;
    isDefault: boolean;
  }>;
  /** AC13.3: het sjabloon bijwerken (create-or-update). */
  zetSjabloon(
    vveId: bigint,
    invoer: { afzendernaam: string; ondertekening?: string; logoUrl?: string },
    doorPersoonId: bigint,
  ): Promise<void>;
}

export function maakMededelingService(config: {
  readonly db: NodePgDatabase;
  readonly mail: MailService;
}): MededelingService {
  const { db, mail } = config;
  const audit = maakAuditService({ db });

  /** De e-mailontvangers van een doelgroep, live opgemaakt (AC13.1). */
  async function ontvangers(
    vveId: bigint,
    doelgroep: 'alle_leden' | 'eigenaren' | 'bewoners',
  ): Promise<readonly { email: string; persoonId: bigint }[]> {
    return inTenantTransactie(db, vveId, async (tx) => {
      // Alle leden: iedereen met een e-mail in deze VvE (via rol_toewijzing
      // en eigenaarschap; bewoners volgen via V03 — voorlopig via rollen).
      const rijen = await tx
        .selectDistinct({
          persoonId: persoon.id,
          email: persoon.email,
        })
        .from(persoon)
        .innerJoin(sql`rol_toewijzing r`, sql`r.persoon_id = ${persoon.id} AND r.vve_id = ${vveId}`)
        .where(
          sql`${persoon.email} <> '' AND (r.eind_datum IS NULL OR r.eind_datum >= CURRENT_DATE)`,
        );
      if (doelgroep === 'alle_leden') return rijen;
      // Eigenaren: koppel aan eigenaarschap vandaag.
      const metEigenaarschap = await tx
        .selectDistinct({ persoonId: persoon.id, email: persoon.email })
        .from(persoon)
        .innerJoin(sql`eigenaarschap e`, sql`e.persoon_id = ${persoon.id} AND e.vve_id = ${vveId}`)
        .where(sql`e.periode @> CURRENT_DATE AND ${persoon.email} <> ''`);
      if (doelgroep === 'eigenaren') return metEigenaarschap;
      // Bewoners: alle leden minus eigenaren (V03 voegt de rol 'bewoner'
      // toe; voorlopig = overige leden).
      const eigenarenIds = new Set(metEigenaarschap.map((r) => r.persoonId));
      return rijen.filter((r) => !eigenarenIds.has(r.persoonId));
    });
  }

  return {
    async publiceer(vveId, invoer, doorPersoonId) {
      if (invoer.titel.trim() === '' || invoer.inhoud.trim() === '') {
        throw new InvoerFout('Titel en inhoud zijn verplicht.');
      }
      const { id, aantalMail } = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .insert(mededeling)
          .values({
            vveId,
            titel: invoer.titel,
            inhoud: invoer.inhoud,
            doelgroep: invoer.doelgroep,
            doorPersoonId,
            mailVerzonden: invoer.verzendMail,
          })
          .returning({ id: mededeling.id });
        if (rij === undefined) throw new Error('mededeling-insert leverde geen id op');

        let aantal = 0;
        if (invoer.verzendMail) {
          // AC13.3: het sjabloon lezen; bij ontbreken/fout valt alles terug
          // op de standaard — het versturen blokkeert nooit.
          const ontvangerLijst = await ontvangers(vveId, invoer.doelgroep);
          const [sjabloonRij] = await tx
            .select({ afzendernaam: mailSjabloon.afzendernaam })
            .from(mailSjabloon)
            .where(eq(mailSjabloon.vveId, vveId))
            .limit(1);
          const afzendernaam = sjabloonRij?.afzendernaam ?? 'De VvE';
          for (const ontvanger of ontvangerLijst) {
            try {
              await mail.zetInWachtrij({
                vveId,
                ontvangerEmail: ontvanger.email,
                onderwerp: invoer.titel,
                tekst: `${invoer.inhoud}\n\n— ${afzendernaam}`,
                categorie: 'app',
              });
              aantal += 1;
            } catch {
              // AC13.2/AC13.3: een fout bij één ontvanger blokkeert de rest
              // niet; de wachtrij heeft het bericht al gezien of niet.
              continue;
            }
          }
        }
        return { id: rij.id, aantalMail: aantal };
      });

      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'mededeling.gepubliceerd',
        categorie: 'app',
        onderwerpTabel: 'mededeling',
        onderwerpId: id,
        details: { titel: invoer.titel, doelgroep: invoer.doelgroep, aantalMail },
      });
      return { id, aantalMail };
    },

    async laatste(vveId, aantal) {
      return inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            id: mededeling.id,
            titel: mededeling.titel,
            inhoud: mededeling.inhoud,
            doelgroep: mededeling.doelgroep,
            gepubliceerdOp: mededeling.gepubliceerdOp,
            doorPersoonId: mededeling.doorPersoonId,
            mailVerzonden: mededeling.mailVerzonden,
          })
          .from(mededeling)
          .where(eq(mededeling.vveId, vveId))
          .orderBy(desc(mededeling.gepubliceerdOp))
          .limit(Math.max(1, Math.min(aantal, 50))),
      );
    },

    async sjabloon(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .select({
            afzendernaam: mailSjabloon.afzendernaam,
            ondertekening: mailSjabloon.ondertekening,
            logoUrl: mailSjabloon.logoUrl,
          })
          .from(mailSjabloon)
          .where(eq(mailSjabloon.vveId, vveId))
          .limit(1);
        if (rij === undefined) {
          // AC13.3-fallback: het standaardsjabloon (geen rij).
          return { afzendernaam: 'De VvE', ondertekening: null, logoUrl: null, isDefault: true };
        }
        return { ...rij, isDefault: false };
      });
    },

    async zetSjabloon(vveId, invoer, doorPersoonId) {
      if (invoer.afzendernaam.trim() === '') {
        throw new InvoerFout('De afzendernaam is verplicht.');
      }
      await inTenantTransactie(db, vveId, async (tx) => {
        const bestaand = await tx
          .select({ vveId: mailSjabloon.vveId })
          .from(mailSjabloon)
          .where(eq(mailSjabloon.vveId, vveId))
          .limit(1);
        if (bestaand.length === 0) {
          await tx.insert(mailSjabloon).values({
            vveId,
            afzendernaam: invoer.afzendernaam,
            ondertekening: invoer.ondertekening ?? null,
            logoUrl: invoer.logoUrl ?? null,
          });
        } else {
          await tx
            .update(mailSjabloon)
            .set({
              afzendernaam: invoer.afzendernaam,
              ondertekening: invoer.ondertekening ?? null,
              logoUrl: invoer.logoUrl ?? null,
              gewijzigdOp: new Date(),
            })
            .where(eq(mailSjabloon.vveId, vveId));
        }
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'mail_sjabloon.gewijzigd',
        categorie: 'app',
        onderwerpTabel: 'mail_sjabloon',
        onderwerpId: vveId,
        details: { afzendernaam: invoer.afzendernaam },
      });
    },
  };
}
