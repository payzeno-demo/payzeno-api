/**
 * RiskModule — RFC platform-v2 §8, the deciding half: the rules engine, its history queries and
 * the `review` table.
 *
 * Imported by PaymentsModule (authorisation asks the engine; the confirm flow opens reviews), so
 * it must not import PaymentsModule back: nothing here moves money. Acting on a review —
 * capture or void — is ReviewsModule's, which sits above both.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';

import { ReviewEntity } from './review.entity';
import { ReviewRepository } from './review.repository';
import { RiskEngine } from './risk-engine.service';
import { RiskSignalsRepository } from './risk-signals.repository';

@Module({
  imports: [CommonModule, TypeOrmModule.forFeature([ReviewEntity])],
  providers: [RiskEngine, RiskSignalsRepository, ReviewRepository],
  exports: [RiskEngine, ReviewRepository],
})
export class RiskModule {}
