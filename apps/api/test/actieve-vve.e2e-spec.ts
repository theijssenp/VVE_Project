/**
 * Integratietest — actieve VvE op de sessie (V02, spec §7.5 stap 2).
 *
 * De TenantGuard bepaalt de tenant uit de `vve_id`-claim van het
 * access-token. Deze suite bewijst het token-mechanisme:
 *   - na `kiesActieveVve` draagt een vers access-token de `vve_id`-claim;
 *   - zonder keuze bevat het token geen claim (TenantGuard weigert dan);
 *   - `verfris` erft de claim van de sessie-rij (rotatie verliest de tenant
 *     niet);
 *   - zonder lopende rol_toewijzing wordt de keuze geweigerd;
 *   - een sessie van een andere persoon wordt geweigerd.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persoon } from '../src/database/schema/index.js';
import { rolToewijzing } from '../src/database/schema/rol-toewijzing.js';
import { vve } from '../src/database/schema/vve.js';
import { SystemKlok } from '../src/gemeenschappelijk/system-klok.js';
import {
  GeenRolInVveFout,
  maakTokenService,
  verifieerAccessToken,
  type TokenService,
} from '../src/gemeenschappelijk/auth/token.js';
import { gedeeldeTestDb, type TestPgDb } from './testcontainers.js';

const GEHEIM = 'test-geheim-voldoende-lange-secret-waarde';

describe('Actieve VvE op de sessie (V02, §7.5)', () => {
  let db: TestPgDb | undefined;
  let tokens: TokenService | undefined;
  let emailAantal = 0;

  beforeAll(async () => {
    db = await gedeeldeTestDb();
    tokens = maakTokenService({ db: db.db, geheim: GEHEIM, klok: new SystemKlok() });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** Seedt persoon + VvE + rol; retourneert alle drie. */
  async function seed(metRol: boolean): Promise<{ persoonId: bigint; vveId: bigint }> {
    if (!db || !tokens) throw new Error('geen setup');
    emailAantal += 1;
    const [p] = await db.db
      .insert(persoon)
      .values({ email: `claim-${String(emailAantal)}@test.vve`, achternaam: 'Claimtest' })
      .returning({ id: persoon.id });
    const [v] = await db.db
      .insert(vve)
      .values({ naam: `Claim-VvE-${String(emailAantal)}` })
      .returning({ id: vve.id });
    if (p === undefined || v === undefined) throw new Error('seed faalde');
    if (metRol) {
      await db.db
        .insert(rolToewijzing)
        .values({ vveId: v.id, persoonId: p.id, rol: 'beheerder', startDatum: '2026-01-01' });
    }
    return { persoonId: p.id, vveId: v.id };
  }

  it('zet de claim: na kiesActieveVve draagt het access-token vve_id', async () => {
    if (!db || !tokens) throw new Error('geen setup');
    const { persoonId, vveId } = await seed(true);
    const { refreshToken } = await tokens.geefTokensUit({ id: persoonId }, {});

    // Vóór de keuze: geen claim.
    const vóór = await tokens.geefTokensUit({ id: persoonId }, {});
    const claimsVóór = await verifieerAccessToken(vóór.accessToken, new SystemKlok(), {
      geheim: GEHEIM,
    });
    expect(claimsVóór.vveId).toBeNull();

    await tokens.kiesActieveVve(persoonId, refreshToken, vveId);

    // Het verversen met het (onveranderde) refresh-token levert een token mét claim.
    const na = await tokens.verfris(refreshToken, {});
    const claims = await verifieerAccessToken(na.accessToken, new SystemKlok(), {
      geheim: GEHEIM,
    });
    expect(claims.vveId).toBe(vveId);
  });

  it('erft de claim bij rotatie (meerdere rondes)', async () => {
    if (!db || !tokens) throw new Error('geen setup');
    const { persoonId, vveId } = await seed(true);
    const { refreshToken: r0 } = await tokens.geefTokensUit({ id: persoonId }, {});
    await tokens.kiesActieveVve(persoonId, r0, vveId);
    const r1 = await tokens.verfris(r0, {});
    const r2 = await tokens.verfris(r1.refreshToken, {});
    const claims = await verifieerAccessToken(r2.accessToken, new SystemKlok(), {
      geheim: GEHEIM,
    });
    expect(claims.vveId).toBe(vveId);
  });

  it('weigert de keuze zonder lopende rol (GeenRolInVveFout)', async () => {
    if (!db || !tokens) throw new Error('geen setup');
    const { persoonId, vveId } = await seed(false);
    const { refreshToken } = await tokens.geefTokensUit({ id: persoonId }, {});
    await expect(tokens.kiesActieveVve(persoonId, refreshToken, vveId)).rejects.toThrow(
      GeenRolInVveFout,
    );
  });

  it('weigert een sessie van een andere persoon', async () => {
    if (!db || !tokens) throw new Error('geen setup');
    const { persoonId: a, vveId } = await seed(true);
    const { refreshToken: rB } = await tokens.geefTokensUit(
      { id: (await seed(true)).persoonId },
      {},
    );
    // sessie B behoort aan persoon B; a mag die niet opwaarderen naar zijn VvE.
    await expect(tokens.kiesActieveVve(a, rB, vveId)).rejects.toThrow();
  });
});
