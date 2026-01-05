/**
 * The card vault client (api-surface.md §16).
 *
 * `resolve()` is the ONLY vault call payzeno-api makes on the normal path. Card data reaches
 * the vault directly from the merchant's checkout page over `VAULT_PUBLIC_URL`; payzeno-api
 * receives a `pmt_` token and nothing else. That is arc PCI's actual scope reduction and it is
 * argued in docs/adr/0014-client-side-tokenisation.md.
 *
 * `tokenise()` is the server-side MOTO path. It is guarded (`@StaffOnly('support')` on the
 * route that reaches it), it logs `SERVER_SIDE_TOKENISATION` at WARN on every call, and it is
 * the thing arc PCI exists to remove. It has not been removed. It is month 12.
 */

import { Injectable } from '@nestjs/common';
import type { PaymentMethodToken } from '@payzeno/contracts';

import { BaseHttpClient, type ApiClientOptions, type RequestSpec, type UpstreamFailure } from '../../api/client';
import type { RetryPolicy } from '../../api/retry.policy';
import type { HttpTransport, TransportError } from '../../api/transport.interface';
import { ValidationException } from '../../common/errors/api.exception';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { UpstreamException } from '../../common/errors/upstream.exceptions';
import type { PayzenoLogger } from '../../common/logging/logger';
import type {
  TokeniseRequest,
  TokeniseResponse,
  TokenResolution,
  VaultDeleteResponse,
  VaultErrorBody,
} from './vault.types';

export interface VaultClientConfig {
  baseUrl: string;
  apiKey: string;
}

@Injectable()
export class VaultClient extends BaseHttpClient {
  constructor(
    private readonly vaultConfig: VaultClientConfig,
    transport: HttpTransport,
    options: ApiClientOptions,
    retryPolicy: RetryPolicy,
    logger: PayzenoLogger,
  ) {
    super(transport, options, retryPolicy, logger);
  }

  protected get baseUrl(): string {
    return this.vaultConfig.baseUrl;
  }

  protected get upstream(): string {
    return 'payzeno-vault';
  }

  protected defaultHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.vaultConfig.apiKey}` };
  }

  /**
   * `POST /tokens/resolve` — the normal path. Called once per authorisation, by
   * `ChargeAuthorizationService`, immediately before the acquirer call.
   */
  async resolve(token: PaymentMethodToken): Promise<TokenResolution> {
    return this.request<TokenResolution, { token: PaymentMethodToken }>({
      method: 'POST',
      path: '/tokens/resolve',
      body: { token },
    });
  }

  /** `DELETE /tokens/{token}` — merchant account closure, and the PCI retention job. */
  async delete(token: PaymentMethodToken): Promise<boolean> {
    const res = await this.request<VaultDeleteResponse>({
      method: 'DELETE',
      path: `/tokens/${encodeURIComponent(token)}`,
    });
    return res.deleted;
  }

  /**
   * `POST /tokens` — legacy server-side tokenisation.
   *
   * TODO(PAY-1721): delete with the MOTO route. Blocked on two merchants who still key
   * telephone orders by hand; see docs/compliance/pci-scope.md §4.
   */
  async tokenise(req: TokeniseRequest, staffId: string): Promise<TokeniseResponse> {
    this.logger.warn('SERVER_SIDE_TOKENISATION', {
      staff_id: staffId,
      // Never the number, never the CVV, not even truncated. The denylist would strip them
      // anyway; not putting them in the context is the belt.
      exp_month: req.exp_month,
      exp_year: req.exp_year,
    });
    return this.request<TokeniseResponse, TokeniseRequest>({
      method: 'POST',
      path: '/tokens',
      body: req,
    });
  }

  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    const body = parseVaultError(failure.rawBody);

    if (failure.status === 404 || body.code === 'token_not_found') {
      throw new ResourceNotFoundException('payment_method_token', failure.spec.path);
    }
    if (failure.status === 400 || failure.status === 422) {
      throw new ValidationException(body.message ?? 'the vault rejected the payment method token', [
        { path: 'payment_method_token', code: body.code ?? 'invalid_token', message: body.message ?? 'invalid token' },
      ]);
    }
    throw new UpstreamException(
      `payzeno-vault responded ${failure.status}`,
      'processor_unavailable',
      { status: failure.status, code: body.code ?? null },
    );
  }

  protected mapTransportFailure(err: TransportError, spec: RequestSpec<unknown>): never {
    throw new UpstreamException(
      `payzeno-vault ${err.kind} on ${spec.method} ${spec.path}`,
      'processor_unavailable',
      { failure: err.kind },
    );
  }
}

function parseVaultError(raw: string): VaultErrorBody {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as VaultErrorBody;
  } catch {
    return { message: 'unparseable vault error body' };
  }
}
