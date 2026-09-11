/**
 * VvE-beheer — blok V01 (spec M1, §3.3 · AC1.1–1.5).
 *
 * De applicatiebeheerder maakt hier een VvE aan en stelt daar meteen een
 * beheerder bij aan. Dat "meteen" is geen gemak maar een eis (AC1.2): een VvE
 * zonder beheerder is een VvE die niemand kan gebruiken, en die situatie mag
 * dus niet bestaan — vandaar dat beide in één transactie gaan.
 *
 * **Afwijking van §3.3, bewust en tijdelijk.** De spec laat de beheerder het
 * wachtwoord genereren en mailen (of een instellink sturen). Zolang SMTP hier
 * niet bruikbaar is, typt de applicatiebeheerder het wachtwoord zélf in en geeft
 * hij het buiten de applicatie om door. Er wordt daardoor nog steeds nergens een
 * wachtwoord in platte tekst bewaard: alleen de argon2id-hash gaat de database
 * in, precies als in het seed-script. Wie het wachtwoord kwijt is, zet een
 * nieuwe — terughalen kan niet en hoort niet te kunnen.
 *
 * `wachtwoord_verloopt_op` blijft hier bewust leeg. De spec zet daar 14 dagen
 * op, maar er is nog geen scherm om een wachtwoord te wijzigen; die datum zou
 * dus een tijdbom zijn die elk account onbruikbaar maakt zodra de controle er
 * wél is. `wachtwoord_wijzigen_verplicht` staat wél aan: dat is de vlag waar
 * dat scherm straks op aanslaat.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { persoon } from '../../database/schema/persoon.js';
import { rolToewijzing } from '../../database/schema/rol-toewijzing.js';
import { vve } from '../../database/schema/vve.js';
import { wooneenheid } from '../../database/schema/wooneenheid.js';
import { grootboekrekening } from '../../database/schema/grootboekrekening.js';
import { maakAuditService } from '../../gemeenschappelijk/audit/audit-service.js';
import { beoordeelWachtwoord, hashWachtwoord } from '../../gemeenschappelijk/auth/wachtwoord.js';
import type { Klok } from '../../gemeenschappelijk/system-klok.js';
import { standaardGrootboekschema } from '../../financieel/grootboek-schema.js';

/** Modelreglementen uit §6.1; los meegetypt zodat de client ze kan tonen. */
export const MODELREGLEMENTEN = [
  'MR1973',
  'MR1983',
  'MR1992',
  'MR2006',
  'MR2017',
  'EIGEN',
] as const;
export type Modelreglement = (typeof MODELREGLEMENTEN)[number];

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

export interface VveVelden {
  readonly naam: string;
  readonly boekjaarStartmaand: number;
  readonly kvkNummer?: string | undefined;
  readonly straat?: string | undefined;
  readonly huisnummer?: string | undefined;
  readonly postcode?: string | undefined;
  readonly plaats?: string | undefined;
  readonly splitsingsdatum?: string | undefined;
  readonly modelreglement?: Modelreglement | undefined;
  readonly breukdeelNoemer?: number | undefined;
  readonly betaaltermijnDagen?: number | undefined;
}

export interface BeheerderVelden {
  readonly email: string;
  readonly achternaam: string;
  readonly voornaam?: string | undefined;
  readonly wachtwoord: string;
}

export interface BeheerderSamenvatting {
  readonly persoonId: bigint;
  readonly email: string;
  readonly naam: string;
  readonly laatsteLoginOp: Date | null;
  readonly actief: boolean;
  readonly wachtwoordWijzigenVerplicht: boolean;
}

export interface VveSamenvatting {
  readonly id: bigint;
  readonly naam: string;
  readonly plaats: string | null;
  readonly status: string;
  readonly boekjaarStartmaand: number;
  readonly aantalEenheden: number;
  readonly beheerders: readonly BeheerderSamenvatting[];
}

const MAANDEN_IN_JAAR = 12;

function verplichteTekst(waarde: unknown, veld: string): string {
  if (typeof waarde !== 'string' || waarde.trim() === '') {
    throw new InvoerFout(`Veld "${veld}" is verplicht.`);
  }
  return waarde.trim();
}

function geldigEmail(waarde: unknown): string {
  const tekst = verplichteTekst(waarde, 'e-mailadres');
  // Bewust ruim: de echte controle is dat er post aankomt, niet een reguliere
  // expressie die legitieme adressen weigert.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tekst)) {
    throw new InvoerFout('Dat is geen geldig e-mailadres.');
  }
  return tekst;
}

/** Weigert een wachtwoord dat de eisen uit F12/§7.6 niet haalt. */
function controleerWachtwoord(tekst: unknown): string {
  if (typeof tekst !== 'string' || tekst === '') {
    throw new InvoerFout('Veld "wachtwoord" is verplicht.');
  }
  const oordeel = beoordeelWachtwoord(tekst);
  if (!oordeel.ok) {
    throw new InvoerFout(oordeel.redenen.join(' '));
  }
  return tekst;
}

function maandUit(waarde: unknown): number {
  const getal = typeof waarde === 'number' ? waarde : Number(waarde);
  if (!Number.isInteger(getal) || getal < 1 || getal > MAANDEN_IN_JAAR) {
    throw new InvoerFout('Startmaand van het boekjaar moet tussen 1 en 12 liggen.');
  }
  return getal;
}

function samengesteldeNaam(rij: {
  voornaam: string | null;
  tussenvoegsel: string | null;
  achternaam: string;
}): string {
  return [rij.voornaam, rij.tussenvoegsel, rij.achternaam]
    .filter((d) => d !== null && d !== '')
    .join(' ');
}

/** `YYYY-MM-DD` van vandaag — `rol_toewijzing.start_datum` is een kalenderdatum. */
function vandaag(klok: Klok): string {
  return klok.nu().toISOString().slice(0, 10);
}

export interface VveServiceConfig {
  readonly db: NodePgDatabase;
  readonly klok: Klok;
}

export interface VveService {
  maakVve(
    velden: VveVelden,
    beheerder: BeheerderVelden,
  ): Promise<{ vveId: bigint; persoonId: bigint }>;
  lijst(): Promise<VveSamenvatting[]>;
  wijzig(vveId: bigint, velden: Partial<VveVelden>): Promise<void>;
  zetStatus(vveId: bigint, status: 'actief' | 'gearchiveerd', doorPersoonId: bigint): Promise<void>;
  zetWachtwoord(
    vveId: bigint,
    persoonId: bigint,
    wachtwoord: string,
    doorPersoonId: bigint,
  ): Promise<{ sessiesIngetrokken: number }>;
  voegBeheerderToe(vveId: bigint, beheerder: BeheerderVelden): Promise<{ persoonId: bigint }>;
}

export function maakVveService(config: VveServiceConfig): VveService {
  const { db, klok } = config;
  const audit = maakAuditService({ db });

  /**
   * Zoekt de persoon bij dit e-mailadres of maakt hem aan, en zet het opgegeven
   * wachtwoord. Bestaat het adres al (iemand is beheerder van twee VvE's, of was
   * al eigenaar elders), dan wordt die persoon hergebruikt — nooit gedupliceerd,
   * want `persoon.email` is uniek en de historie hangt aan het id (§3.3).
   */
  async function persoonKlaarzetten(tx: NodePgDatabase, velden: BeheerderVelden): Promise<bigint> {
    const email = geldigEmail(velden.email);
    const achternaam = verplichteTekst(velden.achternaam, 'achternaam');
    const hash = await hashWachtwoord(controleerWachtwoord(velden.wachtwoord));

    const [bestaand] = await tx
      .select({ id: persoon.id })
      .from(persoon)
      .where(eq(persoon.email, email))
      .limit(1);

    if (bestaand !== undefined) {
      await tx
        .update(persoon)
        .set({
          wachtwoordHash: hash,
          wachtwoordWijzigenVerplicht: true,
          actief: true,
          // Een nieuw wachtwoord heft een lopende blokkade op; anders zou de
          // beheerder een account uitdelen dat de ontvanger niet in kan.
          misluktePogingen: 0,
          geblokkeerdTot: null,
          gewijzigdOp: klok.nu(),
        })
        .where(eq(persoon.id, bestaand.id));
      return bestaand.id;
    }

    const [nieuw] = await tx
      .insert(persoon)
      .values({
        email,
        achternaam,
        ...(velden.voornaam !== undefined && velden.voornaam !== ''
          ? { voornaam: velden.voornaam }
          : {}),
        wachtwoordHash: hash,
        wachtwoordWijzigenVerplicht: true,
        actief: true,
      })
      .returning({ id: persoon.id });
    if (nieuw === undefined) throw new Error('Persoon aanmaken leverde geen id op.');
    return nieuw.id;
  }

  /** Koppelt de persoon als beheerder aan de VvE, als dat nog niet zo is. */
  async function beheerderRolZetten(
    tx: NodePgDatabase,
    vveId: bigint,
    persoonId: bigint,
  ): Promise<void> {
    const lopend = await tx
      .select({ id: rolToewijzing.id })
      .from(rolToewijzing)
      .where(
        and(
          eq(rolToewijzing.vveId, vveId),
          eq(rolToewijzing.persoonId, persoonId),
          eq(rolToewijzing.rol, 'beheerder'),
          isNull(rolToewijzing.eindDatum),
        ),
      )
      .limit(1);
    if (lopend.length > 0) return;
    await tx
      .insert(rolToewijzing)
      .values({ vveId, persoonId, rol: 'beheerder', startDatum: vandaag(klok) });
  }

  function vveWaarden(velden: Partial<VveVelden>): Record<string, unknown> {
    const uit: Record<string, unknown> = {};
    if (velden.naam !== undefined) uit['naam'] = verplichteTekst(velden.naam, 'naam');
    if (velden.boekjaarStartmaand !== undefined) {
      uit['boekjaarStartmaand'] = maandUit(velden.boekjaarStartmaand);
    }
    for (const sleutel of [
      'kvkNummer',
      'straat',
      'huisnummer',
      'postcode',
      'plaats',
      'splitsingsdatum',
      'modelreglement',
    ] as const) {
      const waarde = velden[sleutel];
      if (waarde !== undefined) uit[sleutel] = waarde === '' ? null : waarde;
    }
    if (velden.breukdeelNoemer !== undefined) uit['breukdeelNoemer'] = velden.breukdeelNoemer;
    if (velden.betaaltermijnDagen !== undefined) {
      uit['betaaltermijnDagen'] = velden.betaaltermijnDagen;
    }
    return uit;
  }

  return {
    async maakVve(velden, beheerder) {
      const naam = verplichteTekst(velden.naam, 'naam');
      const maand = maandUit(velden.boekjaarStartmaand);
      // Vóór de transactie: een onbruikbaar wachtwoord mag geen halve VvE opleveren.
      controleerWachtwoord(beheerder.wachtwoord);

      return db.transaction(async (tx) => {
        const [rij] = await tx
          .insert(vve)
          .values({ ...vveWaarden(velden), naam, boekjaarStartmaand: maand })
          .returning({ id: vve.id });
        if (rij === undefined) throw new Error('VvE aanmaken leverde geen id op.');
        const persoonId = await persoonKlaarzetten(tx, beheerder);
        await beheerderRolZetten(tx, rij.id, persoonId);
        // AC9.1: het standaard grootboekschema (§5.7) hoort bij de VvE vanaf
        // het eerste moment, in hetzelfde atomare aanmaakmoment. De kopie
        // loopt binnen deze transactie; RLS is hier geen deur maar een
        // aanmaakcontext (de VvE-rij is net in deze transactie geboren).
        await tx.insert(grootboekrekening).values(
          standaardGrootboekschema(rij.id).map((r) => ({
            vveId: rij.id,
            nummer: r.nummer,
            naam: r.naam,
            categorie: r.categorie,
            isReservefonds: r.isReservefonds,
          })),
        );
        return { vveId: rij.id, persoonId };
      });
    },

    async lijst() {
      const vves = await db
        .select({
          id: vve.id,
          naam: vve.naam,
          plaats: vve.plaats,
          status: vve.status,
          boekjaarStartmaand: vve.boekjaarStartmaand,
        })
        .from(vve)
        .orderBy(desc(vve.id));

      // Beheerders in één slag erbij; per VvE apart bevragen levert N+1 queries.
      const beheerders = await db
        .select({
          vveId: rolToewijzing.vveId,
          persoonId: persoon.id,
          email: persoon.email,
          voornaam: persoon.voornaam,
          tussenvoegsel: persoon.tussenvoegsel,
          achternaam: persoon.achternaam,
          laatsteLoginOp: persoon.laatsteLoginOp,
          actief: persoon.actief,
          wachtwoordWijzigenVerplicht: persoon.wachtwoordWijzigenVerplicht,
        })
        .from(rolToewijzing)
        .innerJoin(persoon, eq(persoon.id, rolToewijzing.persoonId))
        .where(and(eq(rolToewijzing.rol, 'beheerder'), isNull(rolToewijzing.eindDatum)));

      // AC1.5: het aantal eenheden per VvE, ook in één slag.
      const tellingen = await db
        .select({ vveId: wooneenheid.vveId, aantal: sql<number>`count(*)::int` })
        .from(wooneenheid)
        .groupBy(wooneenheid.vveId);

      return vves.map((v) => ({
        ...v,
        aantalEenheden: tellingen.find((t) => t.vveId === v.id)?.aantal ?? 0,
        beheerders: beheerders
          .filter((b) => b.vveId === v.id)
          .map((b) => ({
            persoonId: b.persoonId,
            email: b.email,
            naam: samengesteldeNaam(b),
            laatsteLoginOp: b.laatsteLoginOp,
            actief: b.actief,
            wachtwoordWijzigenVerplicht: b.wachtwoordWijzigenVerplicht,
          })),
      }));
    },

    async wijzig(vveId, velden) {
      const waarden = vveWaarden(velden);
      if (Object.keys(waarden).length === 0) return;
      const rijen = await db
        .update(vve)
        .set({ ...waarden, gewijzigdOp: klok.nu() })
        .where(eq(vve.id, vveId))
        .returning({ id: vve.id });
      if (rijen.length === 0) throw new NietGevondenFout('VvE niet gevonden.');
    },

    async zetStatus(vveId, status, doorPersoonId) {
      const rijen = await db
        .update(vve)
        .set({ status, gewijzigdOp: klok.nu() })
        .where(eq(vve.id, vveId))
        .returning({ id: vve.id });
      if (rijen.length === 0) throw new NietGevondenFout('VvE niet gevonden.');
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: status === 'gearchiveerd' ? 'vve.archiveer' : 'vve.heractiveer',
        categorie: 'app',
        onderwerpTabel: 'vve',
        onderwerpId: vveId,
      });
    },

    async voegBeheerderToe(vveId, beheerder) {
      const [bestaat] = await db.select({ id: vve.id }).from(vve).where(eq(vve.id, vveId)).limit(1);
      if (bestaat === undefined) throw new NietGevondenFout('VvE niet gevonden.');
      return db.transaction(async (tx) => {
        const persoonId = await persoonKlaarzetten(tx, beheerder);
        await beheerderRolZetten(tx, vveId, persoonId);
        return { persoonId };
      });
    },

    async zetWachtwoord(vveId, persoonId, wachtwoord, doorPersoonId) {
      const [rol] = await db
        .select({ id: rolToewijzing.id })
        .from(rolToewijzing)
        .where(
          and(
            eq(rolToewijzing.vveId, vveId),
            eq(rolToewijzing.persoonId, persoonId),
            eq(rolToewijzing.rol, 'beheerder'),
          ),
        )
        .limit(1);
      if (rol === undefined)
        throw new NietGevondenFout('Deze persoon is geen beheerder van deze VvE.');

      const hash = await hashWachtwoord(controleerWachtwoord(wachtwoord));
      const nu = klok.nu();
      await db
        .update(persoon)
        .set({
          wachtwoordHash: hash,
          wachtwoordWijzigenVerplicht: true,
          misluktePogingen: 0,
          geblokkeerdTot: null,
          gewijzigdOp: nu,
        })
        .where(eq(persoon.id, persoonId));

      // AC1.3: het oude wachtwoord én alle lopende sessies vervallen. Dit is het
      // verschil met het seed-script, dat sessies bewust laat staan.
      const ingetrokken = await db.execute<{ id: string }>(sql`
        update apparaat_sessie
           set ingetrokken_op = now(), intrekking_reden = 'wachtwoord opnieuw gezet'
         where persoon_id = ${persoonId}
           and ingetrokken_op is null
        returning id
      `);
      const aantal = ingetrokken.rowCount ?? 0;
      // AC1.3: wie het deed en wanneer moet in het auditlog staan. Het
      // wachtwoord zelf gaat daar nooit in — F12 bewaakt dat met een ESLint-regel.
      await audit.registreer({
        vveId,
        persoonId: doorPersoonId,
        gebeurtenis: 'wachtwoord.reset',
        categorie: 'beveiliging',
        onderwerpTabel: 'persoon',
        onderwerpId: persoonId,
        details: { sessiesIngetrokken: aantal },
      });
      return { sessiesIngetrokken: aantal };
    },
  };
}

/** Alleen de applicatiebeheerder mag in deze module (§3.3). */
export async function isApplicatiebeheerder(
  db: NodePgDatabase,
  persoonId: bigint,
): Promise<boolean> {
  const [rij] = await db
    .select({ vlag: persoon.isApplicatiebeheerder })
    .from(persoon)
    .where(and(eq(persoon.id, persoonId), or(eq(persoon.actief, true))))
    .limit(1);
  return rij?.vlag === true;
}
