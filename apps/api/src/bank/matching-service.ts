/**
 * Matchingmotor — blok B05 (spec M7 · AC7.4–7.6, test #13).
 *
 * Voor elke ongematchte bankmutatie zoekt deze motor uit waar hij bij hoort.
 * De volgorde uit AC7.4 is geen suggestie maar een rangorde van zekerheid, en
 * die rangorde bepaalt ook wát er gebeurt:
 *
 *   1. **Betalingskenmerk** in de omschrijving → exact. Wordt geboekt.
 *   2. **End-to-End-ID** uit een eigen incassobatch → exact. Wordt geboekt.
 *   3. **Tegenrekening → eigenaar → open nota met hetzelfde bedrag** → exact.
 *      Wordt geboekt.
 *   4. **Tegenrekening → eigenaar → oudste open nota's (FIFO)** → alleen een
 *      voorstel zodra het bedrag afwijkt. Dat staat letterlijk in AC7.4 en het
 *      is de belangrijkste rem in dit hele blok: automatisch afboeken op een
 *      afwijkend bedrag maakt van één verkeerde betaling een reeks scheve
 *      openstaande posten die niemand meer terugvindt.
 *   5. **Tegenrekening → leverancier**, en de eigen boekingsregels
 *      ("bevat 'Vitens' → 4310") → voorstel met een kostenrekening.
 *
 * Alles wat niet exact is, blijft in de werkbak staan (AC7.5) — mét het
 * voorstel erbij, zodat bevestigen één handeling is.
 *
 * **Wat deze motor niet doet:** boeken in het grootboek. Hij koppelt een
 * mutatie aan een nota via de betaalservice van G08, of laat een voorstel
 * achter. Zo blijft er één plek waar geld de administratie in gaat.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { bankBoekingsregel, bankVoorstel } from '../database/schema/bank-match.js';
import { bankmutatie, bankrekening } from '../database/schema/bank.js';
import { leverancier } from '../database/schema/leverancier.js';
import { nota } from '../database/schema/nota.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';

export type MatchSoort =
  | 'betalingskenmerk'
  | 'end_to_end'
  | 'iban_bedrag'
  | 'iban_fifo'
  | 'leverancier'
  | 'boekingsregel'
  | 'intern';

export interface Voorstel {
  readonly soort: MatchSoort;
  readonly notaId: bigint | null;
  readonly grootboekrekeningId: bigint | null;
  readonly wooneenheidId: bigint | null;
  readonly bedragCent: number;
  /** 100 = exact en veilig te boeken; alles daaronder is een voorstel. */
  readonly zekerheid: number;
  readonly toelichting: string;
}

export interface MutatieUitkomst {
  readonly bankmutatieId: bigint;
  readonly omschrijving: string;
  readonly bedragCent: number;
  readonly voorstellen: readonly Voorstel[];
  /** Waar is dit op uitgekomen: geboekt, voorgesteld of niets gevonden. */
  readonly uitkomst: 'exact' | 'voorstel' | 'geen';
}

export interface MatchRonde {
  readonly bekeken: number;
  readonly exact: number;
  readonly voorstel: number;
  readonly geen: number;
  readonly mutaties: readonly MutatieUitkomst[];
}

export interface MatchingService {
  /** Loopt alle ongematchte mutaties langs en legt de voorstellen vast. */
  matchOpenstaande(vveId: bigint): Promise<MatchRonde>;
  /** De werkbak (AC7.5): ongematchte mutaties met hun voorstellen. */
  werkbak(vveId: bigint): Promise<readonly MutatieUitkomst[]>;
}

/** Hoe zeker een soort is; bepaalt of er geboekt mag worden. */
const ZEKERHEID: Readonly<Record<MatchSoort, number>> = {
  betalingskenmerk: 100,
  end_to_end: 100,
  iban_bedrag: 100,
  iban_fifo: 70,
  leverancier: 50,
  boekingsregel: 60,
  intern: 90,
};

/**
 * Zoekt een betalingskenmerk in vrije tekst.
 *
 * De omschrijving van een bank is rommelig: hoofdletters, spaties en
 * interpunctie liggen niet vast. Daarom wordt er vergeleken op een
 * genormaliseerde vorm — alleen letters en cijfers, hoofdletters — zodat
 * `NOTA 2026-000123` en `nota2026000123` hetzelfde opleveren.
 */
export function normaliseerVoorZoeken(tekst: string): string {
  return tekst.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function maakMatchingService(config: { readonly db: NodePgDatabase }): MatchingService {
  const { db } = config;

  return {
    async matchOpenstaande(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const mutaties = await tx
          .select({
            id: bankmutatie.id,
            bankrekeningId: bankmutatie.bankrekeningId,
            bedragCent: bankmutatie.bedragCent,
            omschrijving: bankmutatie.omschrijving,
            eindTotEindId: bankmutatie.eindTotEindId,
            tegenrekeningHmac: bankmutatie.tegenrekeningHmac,
            tegenpartijNaam: bankmutatie.tegenpartijNaam,
          })
          .from(bankmutatie)
          .where(and(eq(bankmutatie.vveId, vveId), isNull(bankmutatie.gematchtOp)))
          .orderBy(asc(bankmutatie.boekdatum), asc(bankmutatie.id));

        // De openstaande nota's één keer ophalen in plaats van per mutatie:
        // een werkbak met honderden posten mag geen honderden queries worden.
        const openNotas = await tx
          .select({
            id: nota.id,
            wooneenheidId: nota.wooneenheidId,
            persoonId: nota.persoonId,
            openstaandCent: nota.openstaandCent,
            betalingskenmerk: nota.betalingskenmerk,
            nummer: nota.nummer,
            vervaldatum: nota.vervaldatum,
          })
          .from(nota)
          .where(and(eq(nota.vveId, vveId), sql`${nota.openstaandCent} > 0`))
          .orderBy(asc(nota.vervaldatum), asc(nota.id));

        const regels = await tx
          .select({
            bevat: bankBoekingsregel.bevat,
            grootboekrekeningId: bankBoekingsregel.grootboekrekeningId,
          })
          .from(bankBoekingsregel)
          .where(and(eq(bankBoekingsregel.vveId, vveId), eq(bankBoekingsregel.actief, true)));

        // Eigen rekeningen: een overboeking hiertussen is intern (AC7.6).
        const eigenRekeningen = await tx
          .select({ hmac: bankrekening.ibanHmac })
          .from(bankrekening)
          .where(eq(bankrekening.vveId, vveId));
        const eigenHmacs = new Set(
          eigenRekeningen.map((r) => r.hmac.toString('hex')).filter((h) => h !== ''),
        );

        const uitkomsten: MutatieUitkomst[] = [];
        // Binnen één ronde mag dezelfde nota niet twee keer exact gematcht
        // worden; anders boeken twee betalingen op dezelfde post.
        const alGebruikt = new Set<bigint>();

        for (const m of mutaties) {
          const voorstellen: Voorstel[] = [];
          const genormaliseerd = normaliseerVoorZoeken(m.omschrijving);

          // 1. Betalingskenmerk of notanummer in de omschrijving.
          const opKenmerk = openNotas.find(
            (n) =>
              !alGebruikt.has(n.id) &&
              (genormaliseerd.includes(normaliseerVoorZoeken(n.betalingskenmerk)) ||
                genormaliseerd.includes(normaliseerVoorZoeken(n.nummer))),
          );
          if (opKenmerk !== undefined) {
            voorstellen.push({
              soort: 'betalingskenmerk',
              notaId: opKenmerk.id,
              grootboekrekeningId: null,
              wooneenheidId: opKenmerk.wooneenheidId,
              bedragCent: m.bedragCent,
              zekerheid: ZEKERHEID.betalingskenmerk,
              toelichting: `Betalingskenmerk ${opKenmerk.betalingskenmerk} in de omschrijving.`,
            });
          }

          // 2. End-to-End-ID uit een eigen incassobatch.
          if (voorstellen.length === 0 && m.eindTotEindId !== null) {
            const e2e = normaliseerVoorZoeken(m.eindTotEindId);
            const opE2e = openNotas.find(
              (n) =>
                !alGebruikt.has(n.id) &&
                (normaliseerVoorZoeken(n.betalingskenmerk) === e2e ||
                  normaliseerVoorZoeken(n.nummer) === e2e),
            );
            if (opE2e !== undefined) {
              voorstellen.push({
                soort: 'end_to_end',
                notaId: opE2e.id,
                grootboekrekeningId: null,
                wooneenheidId: opE2e.wooneenheidId,
                bedragCent: m.bedragCent,
                zekerheid: ZEKERHEID.end_to_end,
                toelichting: `End-to-End-ID ${m.eindTotEindId} hoort bij nota ${opE2e.nummer}.`,
              });
            }
          }

          const hmacHex = m.tegenrekeningHmac?.toString('hex') ?? null;

          // AC7.6: een overboeking tussen twee eigen rekeningen is intern en
          // mag nooit als kosten of opbrengst landen.
          if (voorstellen.length === 0 && hmacHex !== null && eigenHmacs.has(hmacHex)) {
            voorstellen.push({
              soort: 'intern',
              notaId: null,
              grootboekrekeningId: null,
              wooneenheidId: null,
              bedragCent: m.bedragCent,
              zekerheid: ZEKERHEID.intern,
              toelichting: 'Overboeking tussen twee eigen rekeningen van de VvE.',
            });
          }

          // 3/4. Tegenrekening → eigenaar → open nota.
          if (voorstellen.length === 0 && hmacHex !== null && m.bedragCent > 0) {
            const eenheden = await eenhedenVanTegenrekening(tx, vveId, m.tegenrekeningHmac);
            const vanEigenaar = openNotas.filter(
              // `wooneenheid_id` is op de nota verplicht, dus geen nullcheck.
              (n) => !alGebruikt.has(n.id) && eenheden.has(n.wooneenheidId),
            );
            const exact = vanEigenaar.find((n) => n.openstaandCent === m.bedragCent);
            if (exact !== undefined) {
              voorstellen.push({
                soort: 'iban_bedrag',
                notaId: exact.id,
                grootboekrekeningId: null,
                wooneenheidId: exact.wooneenheidId,
                bedragCent: m.bedragCent,
                zekerheid: ZEKERHEID.iban_bedrag,
                toelichting: `Tegenrekening hoort bij deze eenheid en het bedrag is exact gelijk aan nota ${exact.nummer}.`,
              });
            } else if (vanEigenaar.length > 0) {
              // FIFO: oudste eerst, maar bewust alléén als voorstel — het
              // bedrag wijkt immers af.
              let rest = m.bedragCent;
              for (const n of vanEigenaar) {
                if (rest <= 0) break;
                const deel = Math.min(rest, n.openstaandCent);
                voorstellen.push({
                  soort: 'iban_fifo',
                  notaId: n.id,
                  grootboekrekeningId: null,
                  wooneenheidId: n.wooneenheidId,
                  bedragCent: deel,
                  zekerheid: ZEKERHEID.iban_fifo,
                  toelichting: `Afwijkend bedrag; voorstel om FIFO af te boeken op nota ${n.nummer} (vervalt ${n.vervaldatum}).`,
                });
                rest -= deel;
              }
            }
          }

          // 5. Leverancier of een eigen boekingsregel → kostenrekening.
          if (voorstellen.length === 0) {
            const zoektekst = `${m.omschrijving} ${m.tegenpartijNaam ?? ''}`.toUpperCase();
            const regel = regels.find((r) => zoektekst.includes(r.bevat.toUpperCase()));
            if (regel !== undefined) {
              voorstellen.push({
                soort: 'boekingsregel',
                notaId: null,
                grootboekrekeningId: regel.grootboekrekeningId,
                wooneenheidId: null,
                bedragCent: m.bedragCent,
                zekerheid: ZEKERHEID.boekingsregel,
                toelichting: `Eigen boekingsregel: omschrijving bevat "${regel.bevat}".`,
              });
            } else if (m.tegenpartijNaam !== null) {
              const [bekend] = await tx
                .select({ id: leverancier.id, naam: leverancier.naam })
                .from(leverancier)
                .where(
                  and(
                    eq(leverancier.vveId, vveId),
                    sql`upper(${leverancier.naam}) = ${m.tegenpartijNaam.toUpperCase()}`,
                  ),
                )
                .limit(1);
              if (bekend !== undefined) {
                voorstellen.push({
                  soort: 'leverancier',
                  notaId: null,
                  grootboekrekeningId: null,
                  wooneenheidId: null,
                  bedragCent: m.bedragCent,
                  zekerheid: ZEKERHEID.leverancier,
                  toelichting: `Bekende leverancier ${bekend.naam}; kies nog een kostenrekening.`,
                });
              }
            }
          }

          // Voorstellen vastleggen: eerst de oude weg, dan de nieuwe erin. Zo
          // blijft de werkbak de huidige stand tonen en niet de geschiedenis.
          await tx.delete(bankVoorstel).where(eq(bankVoorstel.bankmutatieId, m.id));
          for (const v of voorstellen) {
            await tx.insert(bankVoorstel).values({
              vveId,
              bankmutatieId: m.id,
              soort: v.soort,
              notaId: v.notaId,
              grootboekrekeningId: v.grootboekrekeningId,
              wooneenheidId: v.wooneenheidId,
              bedragCent: v.bedragCent,
              zekerheid: v.zekerheid,
              toelichting: v.toelichting,
            });
          }

          const eerste = voorstellen[0];
          const exactGevonden = eerste !== undefined && eerste.zekerheid === 100;
          if (exactGevonden && eerste.notaId !== null) alGebruikt.add(eerste.notaId);

          uitkomsten.push({
            bankmutatieId: m.id,
            omschrijving: m.omschrijving,
            bedragCent: m.bedragCent,
            voorstellen,
            uitkomst: voorstellen.length === 0 ? 'geen' : exactGevonden ? 'exact' : 'voorstel',
          });
        }

        return {
          bekeken: uitkomsten.length,
          exact: uitkomsten.filter((u) => u.uitkomst === 'exact').length,
          voorstel: uitkomsten.filter((u) => u.uitkomst === 'voorstel').length,
          geen: uitkomsten.filter((u) => u.uitkomst === 'geen').length,
          mutaties: uitkomsten,
        };
      });
    },

    async werkbak(vveId) {
      return inTenantTransactie(db, vveId, async (tx) => {
        const mutaties = await tx
          .select({
            id: bankmutatie.id,
            omschrijving: bankmutatie.omschrijving,
            bedragCent: bankmutatie.bedragCent,
          })
          .from(bankmutatie)
          .where(and(eq(bankmutatie.vveId, vveId), isNull(bankmutatie.gematchtOp)))
          .orderBy(asc(bankmutatie.boekdatum), asc(bankmutatie.id));

        const voorstellen = await tx
          .select()
          .from(bankVoorstel)
          .where(eq(bankVoorstel.vveId, vveId));

        return mutaties.map((m) => {
          const eigen = voorstellen
            .filter((v) => v.bankmutatieId === m.id)
            .map((v): Voorstel => ({
              soort: v.soort,
              notaId: v.notaId,
              grootboekrekeningId: v.grootboekrekeningId,
              wooneenheidId: v.wooneenheidId,
              bedragCent: v.bedragCent,
              zekerheid: v.zekerheid,
              toelichting: v.toelichting,
            }));
          const eerste = eigen[0];
          return {
            bankmutatieId: m.id,
            omschrijving: m.omschrijving,
            bedragCent: m.bedragCent,
            voorstellen: eigen,
            uitkomst:
              eigen.length === 0
                ? ('geen' as const)
                : eerste !== undefined && eerste.zekerheid === 100
                  ? ('exact' as const)
                  : ('voorstel' as const),
          };
        });
      });
    },
  };
}

/**
 * Welke eenheden horen bij deze tegenrekening?
 *
 * De koppeling loopt via de SEPA-machtiging: daar staat de IBAN van de eigenaar
 * als HMAC, en die wijst naar een eenheid. Dat is de enige plek waar een
 * privé-IBAN aan een eenheid hangt — precies zoals §6.2 het wil, en zonder de
 * IBAN ooit te ontsleutelen.
 *
 * Er is bewust géén terugval op het eigenaarschap wanneer er geen machtiging
 * is: zonder IBAN-koppeling zou dat een gok zijn op basis van "deze eigenaar
 * heeft ook een openstaande post", en gokken hoort niet in een geldstroom. Zo'n
 * mutatie belandt in de werkbak, waar een mens hem koppelt.
 */
async function eenhedenVanTegenrekening(
  tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
  vveId: bigint,
  hmac: Buffer | null,
): Promise<ReadonlySet<bigint>> {
  if (hmac === null) return new Set();
  const rijen = await tx.execute<{ wooneenheid_id: string }>(sql`
    select m.wooneenheid_id
      from sepa_machtiging m
     where m.vve_id = ${vveId}
       and m.iban_hmac = ${hmac}
       and m.wooneenheid_id is not null
  `);
  const uit = new Set<bigint>();
  for (const rij of rijen.rows) uit.add(BigInt(rij.wooneenheid_id));
  return uit;
}
