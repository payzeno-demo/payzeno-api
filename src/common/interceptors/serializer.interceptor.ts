/**
 * SerializerInterceptor — last link before HttpExceptionFilter.
 *
 * Two jobs:
 *   1. call `toResponse()` on anything that has one, so a controller can return an entity and
 *      the wire still gets the `@payzeno/contracts` shape (`object: 'charge'`, snake_case,
 *      `_minor` integers, RFC 3339 strings).
 *   2. strip `undefined`. `JSON.stringify` drops undefined keys silently, which means an
 *      optional field is sometimes absent and sometimes `null` depending on how it was built.
 *      The contract says nullable fields are present and null.
 */
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/** Anything that knows its own wire shape. Entities implement it; DTOs do not need to. */
export interface Serializable<T> {
  toResponse(): T;
}

@Injectable()
export class SerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => serialize(body)));
  }
}

