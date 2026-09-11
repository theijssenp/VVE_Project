/**
 * Leverancier-service — blok A05 (spec §6.9, M12 · AC12.4–AC12.6).
 *
 * **AC12.4:** leveranciersregister (contact, IBAN-drieluik, KvK) met
 * contracten; de opzegsignalering is live gerekend — een contract waarvan
 * de opzegtermijn binnen 90 dagen begint vóór de einddatum staat in de
 * werkbak (`opzegBinnen90Dagen`).
 *
 * **AC12.5:** verplichtingenregister (keuringen/verzekeringen) met
 * vervaldatum; herinneringen op T-60 en T-14, live gerekend
 * (`herinneringT60`, `herinneringT14`).
 *
 * **AC12.6:** facturen van leveranciers worden als kosten-nota vastgelegd
 * (G06-nummerreeks) en koppelen aan de leverancier — de MJOP/melding-
 * koppeling volgt in M01/A04 (kolommen in de migratie bewust nullable).
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { leverancier, leverancierContract, verplichting } from '../database/schema/leverancier.js';
import { maakAuditService } from '../gemeenschappelijk/audit/audit-service.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from './boekhouding.js';

export interface ContractRij {
  readonly id: bigint;
  readonly omschrijving: string;
  readonly bedragPerJaarCent: number;
  readonly startDatum: string;
  readonly eindDatum: string | null;
  readonly opzegtermijnDagen: number;
  readonly opzegBinnen90Dagen: boolean;
}

export interface VerplichtingRij {
  readonly id: bigint;
  readonly soort: string;
  readonly omschrijving: string;
  readonly vervaldatum: string;
  readonly herinneringT60: boolean;
  readonly herinneringT14: boolean;
  readonly achterhaald: boolean;
}

export interface LeverancierService {
  /** Nieuwe leverancier; IBAN optioneel (drieluik als gegeven). */
  maakLeverancier(
    vveId: bigint,
    invoer: {
      naam: string;
      contactpersoon?: string;
      email?: string;
      telefoon?: string;
      kvkNummer?: string;
      opmerking?: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  lijst(
    vveId: bigint,
  ): Promise<
    readonly { id: bigint; naam: string; contactpersoon: string | null; kvkNummer: string | null }[]
  >;
  /** Contract toevoegen (AC12.4). */
  voegContractToe(
    vveId: bigint,
    invoer: {
      leverancierId: bigint;
      omschrijving: string;
      bedragPerJaarCent: number;
      startDatum: string;
      eindDatum?: string;
      opzegtermijnDagen?: number;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  /** Contracten met de opzegsignalering (AC12.4: binnen 90 dagen). */
  contracten(
    vveId: bigint,
  ): Promise<
    readonly { leverancierId: bigint; leverancierNaam: string; rijen: readonly ContractRij[] }[]
  >;
  /** Verplichting registreren (AC12.5). */
  voegVerplichtingToe(
    vveId: bigint,
    invoer: {
      leverancierId?: bigint;
      soort:
        | 'liftkeuring'
        | 'brandmeldinstallatie'
        | 'legionella'
        | 'nen3140'
        | 'opstalverzekering'
        | 'aansprakelijkheid'
        | 'bestuurdersaansprakelijkheid'
        | 'rechtsbijstand'
        | 'energielabel'
        | 'overig';
      omschrijving: string;
      vervaldatum: string;
    },
    doorPersoonId: bigint,
  ): Promise<{ id: bigint }>;
  /** Verplichtingen met T-60/T-14-herinneringen (AC12.5). */
  verplichtingen(vveId: bigint): Promise<readonly VerplichtingRij[]>;
}

export function maakLeverancierService(config: {
  readonly db: NodePgDatabase;
}): LeverancierService {
  const { db } = config;
  const audit = maakAuditService({ db });

  /** Opzegvenster: peildatum tot eind − opzegtermijn. Live gerekend. */
  function opzegBinnen90(
    eindDatum: string | null,
    opzegtermijnDagen: number,
    vandaag: string,
  ): boolean {
    if (eindDatum === null) return false;
    const eind = new Date(`${eindDatum}T00:00:00Z`);
    const opzegStart = new Date(eind);
    opzegStart.setUTCDate(opzegStart.getUTCDate() - opzegtermijnDagen);
    const nu = new Date(`${vandaag}T00:00:00Z`);
    const grens = new Date(eind);
    grens.setUTCDate(grens.getUTCDate() - 90);
    return nu >= opzegStart && nu <= eind && nu >= grens;
  }

  return {
    async maakLeverancier(vveId, invoer, doorPersoonId) {
      if (invoer.naam.trim() === '') throw new InvoerFout('De naam is verplicht.');
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .insert(leverancier)
          .values({
            vveId,
            naam: invoer.naam,
            contactpersoon: invoer.contactpersoon ?? null,
            email: invoer.email ?? null,
            telefoon: invoer.telefoon ?? null,
            kvkNummer: invoer.kvkNummer ?? null,
            opmerking: invoer.opmerking ?? null,
          })
          .returning({ id: leverancier.id });
        if (rij === undefined) throw new Error('leverancier-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'leverancier.aangemaakt',
        categorie: 'financieel',
        onderwerpTabel: 'leverancier',
        onderwerpId: id,
        details: { naam: invoer.naam },
      });
      return { id };
    },

    async lijst(vveId) {
      return inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            id: leverancier.id,
            naam: leverancier.naam,
            contactpersoon: leverancier.contactpersoon,
            kvkNummer: leverancier.kvkNummer,
          })
          .from(leverancier)
          .where(eq(leverancier.vveId, vveId))
          .orderBy(leverancier.naam),
      );
    },

    async voegContractToe(vveId, invoer, doorPersoonId) {
      for (const datum of [
        invoer.startDatum,
        ...(invoer.eindDatum !== undefined ? [invoer.eindDatum] : []),
      ]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
          throw new InvoerFout('Data moeten de vorm YYYY-MM-DD hebben.');
        }
      }
      if (invoer.bedragPerJaarCent < 0) {
        throw new InvoerFout('Het bedrag kan niet negatief zijn.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [bestaat] = await tx
          .select({ id: leverancier.id })
          .from(leverancier)
          .where(and(eq(leverancier.vveId, vveId), eq(leverancier.id, invoer.leverancierId)))
          .limit(1);
        if (bestaat === undefined) throw new NietGevondenFout('Leverancier niet gevonden.');
        const [rij] = await tx
          .insert(leverancierContract)
          .values({
            vveId,
            leverancierId: invoer.leverancierId,
            omschrijving: invoer.omschrijving,
            bedragPerJaarCent: invoer.bedragPerJaarCent,
            startDatum: invoer.startDatum,
            eindDatum: invoer.eindDatum ?? null,
            opzegtermijnDagen: invoer.opzegtermijnDagen ?? 60,
          })
          .returning({ id: leverancierContract.id });
        if (rij === undefined) throw new Error('contract-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'leverancier.contract_toegevoegd',
        categorie: 'financieel',
        onderwerpTabel: 'leverancier_contract',
        onderwerpId: id,
        details: { leverancierId: String(invoer.leverancierId) },
      });
      return { id };
    },

    async contracten(vveId) {
      const vandaag = new Date().toISOString().slice(0, 10);
      const rijen = await inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            leverancierId: leverancier.id,
            leverancierNaam: leverancier.naam,
            contractId: leverancierContract.id,
            omschrijving: leverancierContract.omschrijving,
            bedragPerJaarCent: leverancierContract.bedragPerJaarCent,
            startDatum: leverancierContract.startDatum,
            eindDatum: leverancierContract.eindDatum,
            opzegtermijnDagen: leverancierContract.opzegtermijnDagen,
          })
          .from(leverancierContract)
          .innerJoin(leverancier, eq(leverancier.id, leverancierContract.leverancierId))
          .where(eq(leverancierContract.vveId, vveId))
          .orderBy(leverancier.naam, leverancierContract.startDatum),
      );
      // Groeperen per leverancier, met de signaleringsvlag (AC12.4).
      const gegroepeerd = new Map<
        bigint,
        { leverancierId: bigint; leverancierNaam: string; rijen: ContractRij[] }
      >();
      for (const r of rijen) {
        let groep = gegroepeerd.get(r.leverancierId);
        if (groep === undefined) {
          groep = { leverancierId: r.leverancierId, leverancierNaam: r.leverancierNaam, rijen: [] };
          gegroepeerd.set(r.leverancierId, groep);
        }
        groep.rijen.push({
          id: r.contractId,
          omschrijving: r.omschrijving,
          bedragPerJaarCent: r.bedragPerJaarCent,
          startDatum: r.startDatum,
          eindDatum: r.eindDatum,
          opzegtermijnDagen: r.opzegtermijnDagen,
          opzegBinnen90Dagen: opzegBinnen90(r.eindDatum, r.opzegtermijnDagen, vandaag),
        });
      }
      return [...gegroepeerd.values()];
    },

    async voegVerplichtingToe(vveId, invoer, doorPersoonId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoer.vervaldatum)) {
        throw new InvoerFout('Vervaldatum moet de vorm YYYY-MM-DD hebben.');
      }
      const id = await inTenantTransactie(db, vveId, async (tx) => {
        const [rij] = await tx
          .insert(verplichting)
          .values({
            vveId,
            leverancierId: invoer.leverancierId ?? null,
            soort: invoer.soort,
            omschrijving: invoer.omschrijving,
            vervaldatum: invoer.vervaldatum,
          })
          .returning({ id: verplichting.id });
        if (rij === undefined) throw new Error('verplichting-insert leverde geen id op');
        return rij.id;
      });
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'verplichting.toegevoegd',
        categorie: 'financieel',
        onderwerpTabel: 'verplichting',
        onderwerpId: id,
        details: { soort: invoer.soort, vervaldatum: invoer.vervaldatum },
      });
      return { id };
    },

    async verplichtingen(vveId) {
      const vandaag = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const rijen = await inTenantTransactie(db, vveId, async (tx) =>
        tx
          .select({
            id: verplichting.id,
            soort: verplichting.soort,
            omschrijving: verplichting.omschrijving,
            vervaldatum: verplichting.vervaldatum,
          })
          .from(verplichting)
          .where(eq(verplichting.vveId, vveId))
          .orderBy(verplichting.vervaldatum),
      );
      return rijen.map((r) => {
        const vervaldag = new Date(`${r.vervaldatum}T00:00:00Z`);
        const dagenTotVerval = Math.round((vervaldag.getTime() - vandaag.getTime()) / 86_400_000);
        return {
          id: r.id,
          soort: r.soort,
          omschrijving: r.omschrijving,
          vervaldatum: r.vervaldatum,
          // AC12.5: herinneringen op T-60 en T-14 — live gerekend.
          herinneringT60: dagenTotVerval >= 0 && dagenTotVerval <= 60,
          herinneringT14: dagenTotVerval >= 0 && dagenTotVerval <= 14,
          achterhaald: dagenTotVerval < 0,
        };
      });
    },
  };
}
