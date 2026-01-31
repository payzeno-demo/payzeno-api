/**
 * Card-vault wire types. arc PCI: nothing here carries a PAN, and nothing here ever will.
 * The vault answers with a `CardSummary` and a fingerprint; the digits stay in the vault's
 * scope, which is the whole SAQ-A-EP argument in docs/compliance/pci-scope.md.
 */

import type { CardSummary, PaymentMethodToken } from '@payzeno/contracts';

export interface TokenResolution {
  token: PaymentMethodToken;
  card: CardSummary;
  /**
   * Stable per-card hash. Used for velocity checks and duplicate-charge heuristics — never
   * reversible, never logged next to a merchant id.
   */
  fingerprint: string;
}

/**
 * The legacy server-side tokenisation body. Only `VaultClient.tokenise` builds it, only the
 * `@StaffOnly('support')` MOTO route reaches it, and arc PCI exists to delete it.
 */
export interface TokeniseRequest {
  /** PAN. This is the ONE type in payzeno-api that admits card digits, and it is on its way out. */
  number: string;
  exp_month: number;
  exp_year: number;
  cvv?: string;
  cardholder_name?: string;
}

export interface TokeniseResponse {
  token: PaymentMethodToken;
  card: CardSummary;
  fingerprint: string;
  created_at: string;
}

export interface VaultDeleteResponse {
  token: PaymentMethodToken;
  deleted: boolean;
}

/** Vault error envelope — not `ApiError`; the vault is a third-party service. */
export interface VaultErrorBody {
  code?: 'token_not_found' | 'token_expired' | 'invalid_token' | string;
  message?: string;
}
