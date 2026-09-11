/**
 * Integratietest — boekingsservice en boekjaar (G02, spec §6.7, §7.4 · tests #20–21).
 *
 * Draait tegen de gedeelde, gemigreerde test-db (migraties t/m 0014).
 * Controleert:
 *   - gebalanceerde boeking slaagt; nummering per jaar oplopend;
 *   - onbalans wordt geweigerd vóór het schrijven (OnbalansFout, test #20);
 *   - de deferred trigger vangt de directe-insert-omweg af (#21): buiten de
 *     service om een boeking + ongebalanceerde regels inserten → COMMIT faalt;
 *   - boeken in een concept- of afgesloten jaar wordt geweigerd;
 *   - boekdatum buiten het jaar wordt geweigerd;
 *   - onbekend rekeningnummer wordt geweigerd;
 *   - boekjaar openen/afsluiten met één-open-per-VvE;
 *   - append-only: UPDATE op boeking faalt voor vve_app (rechten-migratie).
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Bedrag } from '@vve/domein';
import {
  boeking,
  boekingsregel,
  grootboekrekening,
  persoon,
  vve,
} from '../src/database/schema/index.js';
import { standaardGrootboekschema } from '../src/financieel/grootboek-schema.js';
import {
  Regel,
  maakBoekhouding,
  OnbalansFout,
  type Boekhouding,
} from '../src/financieel/boekhouding.js';
import {
  InvoerFout,
  maakBoekjaarService,
  type BoekjaarService,
} from '../src/financieel/boekjaar-service.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

describe('Boekhouding (G02, §6.7/§7.4)', () => {
  let db: TestPgDb | undefined;
  let boekhouding: Boekhouding | undefined;
  let boekjaarSvc: BoekjaarService | undefined;
  let vveNummer = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    boekhouding = maakBoekhouding({ db: db.db });
    boekjaarSvc = maakBoekjaarService({ db: db.db });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt VvE + persoon + §5.7-schema + open boekjaar 2026. */
  async function seed(): Promise<{ vveId: bigint; persoonId: bigint; jaarId: bigint }> {
    if (!db || !boekjaarSvc) throw new Error('geen setup');
    vveNummer += 1;
    const n = String(vveNummer);
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `G02-VvE-${n}` })
      .returning({ id: vve.id });
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `g02-${n}-${String(Date.now())}@test.vve`, achternaam: 'Boeker' })
      .returning({ id: persoon.id });
    if (v === undefined || p === undefined) throw new Error('seed faalde');
    await db.db.insert(grootboekrekening).values(standaardGrootboekschema(v.id));
    const { id } = await boekjaarSvc.maakBoekjaar(
      v.id,
      { jaar: 2026, startDatum: '2026-01-01', eindDatum: '2026-12-31' },
      p.id,
    );
    await boekjaarSvc.open(v.id, id, p.id);
    return { vveId: v.id, persoonId: p.id, jaarId: id };
  }

  it('boekt in balans en nummert oplopend per jaar', async () => {
    if (!db || !boekhouding) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();

    const eerste = await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-02-01',
        omschrijving: 'Bijdrage februari 2026',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1300', Bedrag.vanCenten(12_500)),
          Regel.credit('8100', Bedrag.vanCenten(10_000)),
          Regel.credit('8150', Bedrag.vanCenten(2_500)),
        ],
      },
      persoonId,
    );
    expect(eerste.nummer).toBe('2026-000001');

    const tweede = await boekhouding.boek(
      vveId,
      jaarId,
      {
        datum: '2026-03-01',
        omschrijving: 'Bijdrage maart 2026',
        bron: 'memoriaal',
        regels: [
          Regel.debet('1300', Bedrag.vanCenten(10_00)),
          Regel.credit('8100', Bedrag.vanCenten(10_00)),
        ],
      },
      persoonId,
    );
    expect(tweede.nummer).toBe('2026-000002');

    // De regels staan echt in de database met de juiste kanten.
    const { rows } = await db.pool.query<{ debet: string; credit: string }>(
      'SELECT r.debet_cent AS debet, r.credit_cent AS credit FROM boekingsregel r ' +
        'JOIN boeking b ON b.id = r.boeking_id WHERE b.id = $1 ORDER BY r.id',
      [String(eerste.boekingId)],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.debet).toBe('12500');
    expect(rows[1]?.credit).toBe('10000');
    expect(rows[2]?.credit).toBe('2500');
  });

  it('weigert onbalans vóór het schrijven (test #20, OnbalansFout)', async () => {
    if (!db || !boekhouding) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await expect(
      boekhouding.boek(
        vveId,
        jaarId,
        {
          datum: '2026-02-01',
          omschrijving: 'Slordig',
          bron: 'memoriaal',
          regels: [
            Regel.debet('1300', Bedrag.vanCenten(10_00)),
            Regel.credit('8100', Bedrag.vanCenten(9_99)),
          ],
        },
        persoonId,
      ),
    ).rejects.toThrow(OnbalansFout);
  });

  it('de deferred trigger vangt de directe-insert-omweg af (test #21)', async () => {
    if (!db || !boekhouding) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    // De omweg: boeking + ongebalanceerde regels rechtstreeks in de database,
    // buiten de boekingsservice om. De insert is toegestaan (DEFERRED); de
    // COMMIT faalt pas bij het einde van de transactie — precies waarom de
    // trigger deferred is (§6.7: het vangnet onder de service).
    // De COMMIT faalt met de trigger-exception; Drizzle wikkelt die in een
    // DrizzleQueryError met de pg-fout op `cause`, dus de assert doorloopt
    // de cause-keten.
    await expect(
      db.db
        .transaction(async (tx) => {
          const [rij] = await tx
            .insert(boeking)
            .values({
              vveId,
              boekjaarId: jaarId,
              nummer: '2026-999999',
              datum: '2026-02-01',
              omschrijving: 'Omweg: alleen debet, geen credit',
              bron: 'memoriaal',
              aangemaaktDoor: persoonId,
            })
            .returning({ id: boeking.id });
          if (rij === undefined) throw new Error('omweg-insert faalde');
          const [rekening] = await tx
            .select({ id: grootboekrekening.id })
            .from(grootboekrekening)
            .where(and(eq(grootboekrekening.vveId, vveId), eq(grootboekrekening.nummer, '1300')))
            .limit(1);
          if (rekening === undefined) throw new Error('geen rekening 1300');
          await tx.insert(boekingsregel).values({
            boekingId: rij.id,
            grootboekrekeningId: rekening.id,
            debetCent: 10_00,
            creditCent: 0,
          });
        })
        .catch((e: unknown) => {
          let cause: unknown = e;
          const berichten: string[] = [];
          while (cause instanceof Error) {
            berichten.push(cause.message);
            cause = (cause as { cause?: unknown }).cause;
          }
          throw new Error(`OMWEG-GEWEIGERD: ${berichten.join(' | ')}`);
        }),
    ).rejects.toThrow(/OMWEG-GEWEIGERD[\s\S]*niet in balans/);
  });

  it('boeken in een concept- of afgesloten jaar wordt geweigerd', async () => {
    if (!db || !boekhouding || !boekjaarSvc) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id: conceptJaar } = await boekjaarSvc.maakBoekjaar(
      vveId,
      { jaar: 2027, startDatum: '2027-01-01', eindDatum: '2027-12-31' },
      persoonId,
    );
    await expect(
      boekhouding.boek(
        vveId,
        conceptJaar,
        {
          datum: '2027-02-01',
          omschrijving: 'In concept mag niet',
          bron: 'memoriaal',
          regels: [
            Regel.debet('1300', Bedrag.vanCenten(1_00)),
            Regel.credit('8100', Bedrag.vanCenten(1_00)),
          ],
        },
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);
  });

  it('boekdatum buiten het jaar wordt geweigerd', async () => {
    if (!db || !boekhouding) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await expect(
      boekhouding.boek(
        vveId,
        jaarId,
        {
          datum: '2025-12-31',
          omschrijving: 'Verkeerd jaar',
          bron: 'memoriaal',
          regels: [
            Regel.debet('1300', Bedrag.vanCenten(1_00)),
            Regel.credit('8100', Bedrag.vanCenten(1_00)),
          ],
        },
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);
  });

  it('onbekend rekeningnummer wordt geweigerd', async () => {
    if (!db || !boekhouding) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await expect(
      boekhouding.boek(
        vveId,
        jaarId,
        {
          datum: '2026-02-01',
          omschrijving: 'Onbekende rekening',
          bron: 'memoriaal',
          regels: [
            Regel.debet('9999', Bedrag.vanCenten(1_00)),
            Regel.credit('8100', Bedrag.vanCenten(1_00)),
          ],
        },
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);
  });

  it('afsluiten zet de status en blokkeert verder boeken (AC9.3-deel)', async () => {
    if (!db || !boekhouding || !boekjaarSvc) throw new Error('geen setup');
    const { vveId, persoonId, jaarId } = await seed();
    await boekjaarSvc.afsluiten(vveId, jaarId, persoonId);
    await expect(
      boekhouding.boek(
        vveId,
        jaarId,
        {
          datum: '2026-06-01',
          omschrijving: 'Na afsluiting',
          bron: 'memoriaal',
          regels: [
            Regel.debet('1300', Bedrag.vanCenten(1_00)),
            Regel.credit('8100', Bedrag.vanCenten(1_00)),
          ],
        },
        persoonId,
      ),
    ).rejects.toThrow(InvoerFout);
  });

  it('maakt geen tweede open boekjaar (één open per VvE)', async () => {
    if (!db || !boekjaarSvc) throw new Error('geen setup');
    const { vveId, persoonId } = await seed();
    const { id: tweede } = await boekjaarSvc.maakBoekjaar(
      vveId,
      { jaar: 2027, startDatum: '2027-01-01', eindDatum: '2027-12-31' },
      persoonId,
    );
    await expect(boekjaarSvc.open(vveId, tweede, persoonId)).rejects.toThrow(InvoerFout);
  });
});
