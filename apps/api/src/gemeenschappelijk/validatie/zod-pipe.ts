/**
 * Zod-validatiepipe — F08 (spec §7.5 stap 4, test #30).
 *
 * Eén schema is tegelijk runtime-validatie op de API én het TypeScript-type
 * in de Ionic-client (§7.1). Onbekende velden worden geweigerd (`.strict()`)
 * — de bescherming tegen mass assignment.
 *
 * Gebruik als Nest-pipe: `@Body(new ZodValidationPipe(schema))`.
 * Direct aanroepbaar (`parseStrikt`) voor de tests en de services.
 */

import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(waarde: unknown): T {
    const uitslag = this.schema.safeParse(waarde);
    if (!uitslag.success) {
      // Foutdetails naar de client zijn hier bewust beperkt tot het pad:
      // veldnamen mogen de client helpen, stacktraces nooit (§8.2).
      const eerste = uitslag.error.issues[0];
      const pad = eerste?.path.join('.') ?? '(body)';
      throw new BadRequestException(`Ongeldige invoer op "${pad}"`);
    }
    return uitslag.data;
  }
}

/** Directe parse met dezelfde foutvorm (voor services en tests). */
export function parseStrikt<T>(schema: ZodType<T>, waarde: unknown): T {
  const pipe = new ZodValidationPipe(schema);
  return pipe.transform(waarde);
}