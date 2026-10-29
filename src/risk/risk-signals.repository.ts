/**
 * L1. The read side of the risk rules: velocity and history queries over `charge`.
 *
 * Read-only, and the only reader of the §8 charge columns besides the charge itself. Velocity is
 * platform-wide on purpose — a card being tested against five merchants is one signal, not five
 * quiet ones — and split by mode, so test traffic never colours a live decision.
 */
import { Injectable } from '@nestjs/common';
import type { ChargeId, CurrencyCode, MerchantId } from '@payzeno/contracts';
import { DataSource } from 'typeorm';

import { ChargeEntity } from '../payments/charge.entity';

export interface CardVelocity {
  attempts: number;
  failures: number;
}

export interface MerchantHistory {
  averageMinor: number | null;
  sampleSize: number;
}

@Injectable()
export class RiskSignalsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Other attempts with this card since `since`: all of them, and the declined or blocked ones. */
  async cardVelocity(fingerprint: string, livemode: boolean, since: Date, excludeChargeId: ChargeId): Promise<CardVelocity> {
    const row = await this.dataSource
      .getRepository(ChargeEntity)
      .createQueryBuilder('charge')
      .select('count(*)', 'attempts')
      .addSelect(`count(*) filter (where charge.status = 'failed' or charge.risk_outcome = 'block')`, 'failures')
      .where('charge.card_fingerprint = :fingerprint', { fingerprint })
      .andWhere('charge.livemode = :livemode', { livemode })
      .andWhere('charge.created_at > :since', { since })
      .andWhere('charge.id <> :excludeChargeId', { excludeChargeId })
      .getRawOne<{ attempts: string; failures: string }>();
    return { attempts: Number(row?.attempts ?? 0), failures: Number(row?.failures ?? 0) };
  }

  /** Distinct cards seen from one shopper address since `since`, this attempt's included. */
  async distinctCardsFromIp(ip: string, livemode: boolean, since: Date): Promise<number> {
    const row = await this.dataSource
      .getRepository(ChargeEntity)
      .createQueryBuilder('charge')
      .select('count(distinct charge.card_fingerprint)', 'cards')
      .where('charge.shopper_ip = :ip', { ip })
      .andWhere('charge.livemode = :livemode', { livemode })
      .andWhere('charge.created_at > :since', { since })
      .andWhere('charge.card_fingerprint is not null')
      .getRawOne<{ cards: string }>();
    return Number(row?.cards ?? 0);
  }

  /** The merchant's captured average in one currency since `since`. */
  async merchantHistory(merchantId: MerchantId, currency: CurrencyCode, livemode: boolean, since: Date): Promise<MerchantHistory> {
    const row = await this.dataSource
      .getRepository(ChargeEntity)
      .createQueryBuilder('charge')
      .select('count(*)', 'samples')
      .addSelect('avg(charge.captured_amount_minor)', 'average')
      .where('charge.merchant_id = :merchantId', { merchantId })
      .andWhere('charge.livemode = :livemode', { livemode })
      .andWhere('charge.currency = :currency', { currency })
      .andWhere(`charge.status in ('captured', 'settled')`)
      .andWhere('charge.captured_at > :since', { since })
      .getRawOne<{ samples: string; average: string | null }>();
    const sampleSize = Number(row?.samples ?? 0);
    return {
      sampleSize,
      averageMinor: sampleSize > 0 && row?.average ? Math.round(Number(row.average)) : null,
    };
  }
}
