/**
 * DisputeRateCalculator — trailing-30-day dispute rate, in basis points.
 *
 * The definition is the scheme definition, not a convenient one:
 *
 *     rate_bps = round( disputes_opened_in_window / charges_captured_in_window * 10000 )
 *
 * Two things about it are easy to get wrong and both change the answer materially:
 *
 *  - the denominator is CAPTURED charges, not authorised ones. An authorisation that was
 *    never captured cannot be disputed, and counting it flatters the rate for exactly the
 *    merchants whose auth-to-capture ratio is worst.
 *  - both windows are the same 30 days by CHARGE date, not by dispute date. A dispute arrives
 *    up to 120 days after the charge, so counting "disputes opened this month" against
 *    "charges captured this month" compares two disjoint populations. Visa's threshold
 *    programme uses the same-month approximation; we use it too, and the comment exists so
 *    nobody "fixes" it into a cohort calculation that produces different numbers to the ones
 *    the schemes send us.
 *
 * Pure. `RiskEvaluationService` does the counting and hands the numbers here.
 */
import { Injectable } from '@nestjs/common';

export interface DisputeRateInput {
  capturedCharges: number;
  disputesOpened: number;
}

export const MINIMUM_SAMPLE = 50;

@Injectable()
