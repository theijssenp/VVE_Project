/**
 * Health-endpoint contract.
 *
 * Eén Zod-schema is tegelijk de runtime-validatie op de API (apps/api) én het
 * TypeScript-type in de (latere) Ionic-client. Zie spec §7.1 / §7.2.
 */
import { z } from 'zod';

export const healthResponse = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponse>;
