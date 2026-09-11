/**
 * BigInt-serialisatie — API-breed.
 *
 * Alle sleutels in dit schema zijn `bigint` (§6), en `JSON.stringify` weigert
 * die: "Do not know how to serialize a BigInt". Zonder deze interceptor loopt
 * élk endpoint dat een id teruggeeft op een 500 — en dat merk je pas als het
 * endpoint bestaat, niet bij het compileren.
 *
 * De omzetting is naar **string**, niet naar number: een `bigint` past niet
 * gegarandeerd in een JavaScript-number, en een id dat stilzwijgend afrondt is
 * erger dan een id dat je moet parsen.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

export function bigintNaarString(waarde: unknown): unknown {
  if (typeof waarde === 'bigint') return waarde.toString();
  if (Array.isArray(waarde)) return waarde.map(bigintNaarString);
  if (waarde instanceof Date) return waarde;
  if (typeof waarde === 'object' && waarde !== null) {
    return Object.fromEntries(
      Object.entries(waarde).map(([sleutel, v]) => [sleutel, bigintNaarString(v)]),
    );
  }
  return waarde;
}

@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, volgende: CallHandler): Observable<unknown> {
    return volgende.handle().pipe(map(bigintNaarString));
  }
}
