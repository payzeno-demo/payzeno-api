/**
 * L1. The only writer of `fx_quote`. Append-only: insert and read, never update.
 */
import { Injectable } from '@nestjs/common';
import type { CheckoutSessionId, CurrencyCode } from '@payzeno/contracts';
import { DataSource, Repository } from 'typeorm';

import { toInsertRow } from '../common/persistence/payzeno.repository';
import { mapTypeOrmError } from '../common/persistence/typeorm-error.mapper';

import { FxQuoteEntity } from './fx-quote.entity';

@Injectable()
export class FxQuoteRepository extends Repository<FxQuoteEntity> {
  constructor(dataSource: DataSource) {
    super(FxQuoteEntity, dataSource.createEntityManager());
  }

  async insertQuote(row: FxQuoteEntity): Promise<FxQuoteEntity> {
    try {
      await this.insert(toInsertRow(row));
    } catch (err) {
      throw mapTypeOrmError(err);
    }
    return row;
  }

  findById(id: string): Promise<FxQuoteEntity | null> {
    return this.findOne({ where: { id } });
  }

  /** The newest quote a session was shown for this pair that is still good until `validUntil`. */
  findReusable(
    checkoutSessionId: CheckoutSessionId,
    from: CurrencyCode,
    to: CurrencyCode,
    validUntil: Date,
  ): Promise<FxQuoteEntity | null> {
    return this.createQueryBuilder('fx_quote')
      .where('fx_quote.checkout_session_id = :checkoutSessionId', { checkoutSessionId })
      .andWhere('fx_quote.from_currency = :from', { from })
      .andWhere('fx_quote.to_currency = :to', { to })
      .andWhere('fx_quote.expires_at > :validUntil', { validUntil })
      .orderBy('fx_quote.expires_at', 'DESC')
      .getOne();
  }
}
