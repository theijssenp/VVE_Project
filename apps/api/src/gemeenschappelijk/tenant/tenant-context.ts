/**
 * TenantContext + RLS-transactiehelper — F04 (spec §6.9, §7.5).
 *
 * De enige plek waar `app.vve_id` wordt gezet: altijd via `SET LOCAL` binnen
 * dezelfde transactie als de query (pooling in transaction-modus lekt dan niet
 * naar de volgende gebruiker; spec §6.9 "Connection pooling").
 *
 * `current_setting('app.vve_id')` werpt een fout als de instelling ontbreekt —
 * fail closed (spec §6.9). Deze helper garandeert dat elke tenant-query binnen
 * een transactie met gezette instelling draait, door de instelling in dezelfde
 * transactie te zetten als de query zelf.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Vaste naam van de Postgres-instelling (spec §6.9). */
export const TENANT_INSTELLING = 'app.vve_id' as const;

/**
 * Het transactie-object dat `NodePgDatabase.transaction` doorgeeft aan zijn
 * callback (structureel afgeleid, geen nieuwe naam uit de documentatie gokken).
 */
type TenantTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/**
 * Gevulde tenantcontext per request (§7.5 stap 2, TenantGuard). Het `vve_id`
 * komt uit het geverifieerde token, NOOIT uit de request-parameters.
 */
export interface TenantContext {
  readonly vveId: bigint;
  readonly persoonId: bigint;
}

/**
 * Voert `arbeid` uit binnen één transactie waarin `app.vve_id` is gezet op
 * `vveId` (SET LOCAL — valt weg bij het einde van de transactie).
 *
 * - `db.transaction` pakt een client uit de pool en COMMIT/ROLLBACK hem.
 * - Fail closed: binnen de transactie werpt `current_setting('app.vve_id')`
 *   een fout als dit niet is gezet; zonder deze helper bestaat dat pad niet.
 * - Rollback gebeurt automatisch bij een throw uit `arbeid`.
 */
export async function inTenantTransactie<T>(
  db: NodePgDatabase,
  vveId: bigint,
  arbeid: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const id = Number(vveId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`inTenantTransactie: ongeldig vve_id ${String(id)}`);
  }
  return db.transaction(async (tx) => {
    // SET LOCAL is transactielokaal: de instelling verdwijnt bij COMMIT/ROLLBACK,
    // ook bij hergebruik van de pool-client (transaction-mode pooling, §6.9).
    // String(id) is hier veilig: id is hierboven gevalideerd als veilig geheel getal > 0.
    await tx.execute(sql.raw(`SET LOCAL ${TENANT_INSTELLING} = ${String(id)}`));
    return arbeid(tx);
  });
}

/**
 * Leest de actieve tenant uit de huidige sessie-instelling (voor de
 * Objectcontrole in de service, §7.5 stap 6). Werpt als de instelling
 * ontbreekt — zelfde fail-closed-gedrag als de RLS-policies.
 */
export async function actieveVveId(db: NodePgDatabase): Promise<bigint> {
  const resultaat = await db.execute<{ instelling: string }>(
    sql`SELECT current_setting(${TENANT_INSTELLING}) AS instelling`,
  );
  const rij = resultaat.rows[0];
  if (!rij) throw new Error('actieveVveId: geen rij uit current_setting');
  const waarde = BigInt(rij.instelling);
  if (waarde <= 0n) throw new Error(`actieveVveId: ongeldig vve_id ${rij.instelling}`);
  return waarde;
}
