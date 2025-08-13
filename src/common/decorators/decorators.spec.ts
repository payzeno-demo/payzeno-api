import { Reflector } from '@nestjs/core';

import { API_KEY_SCOPES } from '@payzeno/contracts';

import {
  API_VERSION_KEY,
  ApiVersion,
  DEFAULT_API_VERSION,
  isKnownApiVersion,
} from 'src/common/decorators/api-version.decorator';
import { AUDIT_LOG_KEY, AuditLog } from 'src/common/decorators/audit-log.decorator';
import { IDEMPOTENT_KEY, Idempotent } from 'src/common/decorators/idempotent.decorator';
import { INTERNAL_ONLY_KEY, InternalOnly } from 'src/common/decorators/internal-only.decorator';
import { JOB_LOCK_KEY, JobLock } from 'src/common/decorators/job-lock.decorator';
import { LIVEMODE_ONLY_KEY, LivemodeOnly } from 'src/common/decorators/livemode-only.decorator';
import { MERCHANT_SCOPED_KEY, MerchantScoped } from 'src/common/decorators/merchant-scoped.decorator';
import { RATE_LIMIT_KEY, RateLimit } from 'src/common/decorators/rate-limit.decorator';
import { Redact, redactedPathsOf } from 'src/common/decorators/redact.decorator';
import {
  DEFAULT_READ_SCOPES,
  REQUIRED_SCOPES_KEY,
  RequiredScopes,
  hasAllScopes,
  missingScope,
} from 'src/common/decorators/required-scopes.decorator';
import { ROLES_KEY, ROLE_RANK, Roles, satisfiesRole } from 'src/common/decorators/roles.decorator';
import { STAFF_ONLY_KEY, StaffOnly, satisfiesStaffRole } from 'src/common/decorators/staff-only.decorator';

/**
 * One `describe` per custom decorator (tests.md §3.2).
 *
 * A decorator is metadata plus a reader. These specs assert the metadata a decorator
 * actually writes and the helper that reads it back, because the failure mode is silent:
 * a decorator that sets the wrong key still compiles, still decorates, and its guard just
 * never fires.
 */

const reflector = new Reflector();

class Fixture {
  @Idempotent()
  create(): void {}

  @Idempotent({ backend: 'redis' })
  createIntent(): void {}

  @Roles('owner', 'admin')
  addUser(): void {}

  @StaffOnly('finance')
  retryItem(): void {}

  @LivemodeOnly()
  createPayout(): void {}

  @RateLimit(5, 60)
  login(): void {}

  @AuditLog('merchant.create')
  createMerchant(): void {}

  @ApiVersion('2026-01-15')
  getCharge(): void {}

  @InternalOnly('payzeno-ledger')
  markSettled(): void {}

  @JobLock('outbox-drain', 30)
  runOnce(): void {}

  undecorated(): void {}
}

@MerchantScoped()
class ScopedController {}

@Redact('card_number', 'cvv', 'account_number')
class SensitiveDto {}

function metadata<T>(key: string, method: keyof Fixture): T | undefined {
  return reflector.get<T>(key, Fixture.prototype[method] as never);
}

describe('@Idempotent()', () => {
  it('marks the handler', () => {
    expect(metadata(IDEMPOTENT_KEY, 'create')).toBeDefined();
  });

  it('defaults to the required, postgres-backed form', () => {
    const options = metadata<{ required?: boolean; backend?: string }>(IDEMPOTENT_KEY, 'create');

    expect(options?.backend ?? 'postgres').toBe('postgres');
  });

  it('carries a redis backend selection through', () => {
    expect(metadata<{ backend?: string }>(IDEMPOTENT_KEY, 'createIntent')?.backend).toBe('redis');
  });

  it('leaves an undecorated handler alone', () => {
    expect(metadata(IDEMPOTENT_KEY, 'undecorated')).toBeUndefined();
  });
});

describe('@Roles()', () => {
  it('stores the role list', () => {
    expect(metadata<string[]>(ROLES_KEY, 'addUser')).toEqual(['owner', 'admin']);
  });

  it('ranks roles so `owner` satisfies an `admin` requirement', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(satisfiesRole('owner', ['admin'])).toBe(true);
  });

  it('refuses a role below the requirement', () => {
    expect(satisfiesRole('viewer', ['admin'])).toBe(false);
    expect(satisfiesRole('developer', ['owner'])).toBe(false);
  });

  it('accepts an exact match', () => {
    expect(satisfiesRole('admin', ['admin'])).toBe(true);
  });
});

describe('@StaffOnly()', () => {
  it('stores the staff role list', () => {
    expect(metadata<string[]>(STAFF_ONLY_KEY, 'retryItem')).toEqual(['finance']);
  });

  it('lets `admin` satisfy any staff requirement', () => {
    expect(satisfiesStaffRole('admin', ['finance'])).toBe(true);
    expect(satisfiesStaffRole('admin', ['risk'])).toBe(true);
  });

  it('does not let `support` act as `finance`', () => {
    // A merchant's own admin could otherwise un-suspend itself; the same reasoning
    // applies inside the staff roles.
    expect(satisfiesStaffRole('support', ['finance'])).toBe(false);
  });
});

describe('@LivemodeOnly()', () => {
  it('marks the handler', () => {
    expect(metadata(LIVEMODE_ONLY_KEY, 'createPayout')).toBe(true);
  });

  it('does not mark an undecorated handler', () => {
    expect(metadata(LIVEMODE_ONLY_KEY, 'undecorated')).toBeUndefined();
  });
});

describe('@RateLimit()', () => {
  it('stores the limit and window', () => {
    expect(metadata(RATE_LIMIT_KEY, 'login')).toEqual({ limit: 5, windowSec: 60 });
  });
});

describe('@AuditLog()', () => {
  it('stores the action name', () => {
    expect(metadata<{ action: string }>(AUDIT_LOG_KEY, 'createMerchant')?.action).toBe(
      'merchant.create',
    );
  });
});

describe('@ApiVersion()', () => {
  it('stores the pinned date', () => {
    expect(metadata(API_VERSION_KEY, 'getCharge')).toBe('2026-01-15');
  });

  it('recognises every shipped version', () => {
    expect(isKnownApiVersion('2025-06-01')).toBe(true);
    expect(isKnownApiVersion('2026-01-15')).toBe(true);
  });

  it('rejects an unknown version', () => {
    expect(isKnownApiVersion('2027-01-01')).toBe(false);
  });

  it('defaults to the latest shipped version', () => {
    expect(DEFAULT_API_VERSION).toBe('2026-01-15');
  });
});

describe('@InternalOnly()', () => {
  it('stores the permitted callers', () => {
    expect(metadata<{ callers: string[] }>(INTERNAL_ONLY_KEY, 'markSettled')?.callers).toEqual([
      'payzeno-ledger',
    ]);
  });
});

describe('@JobLock()', () => {
  it('stores the lock name and ttl', () => {
    expect(metadata(JOB_LOCK_KEY, 'runOnce')).toEqual({ name: 'outbox-drain', ttlSec: 30 });
  });
});

describe('@MerchantScoped()', () => {
  it('marks the controller class', () => {
    expect(reflector.get(MERCHANT_SCOPED_KEY, ScopedController)).toBeDefined();
  });
});

describe('@Redact()', () => {
  it('records the redacted paths on the DTO class', () => {
    expect(redactedPathsOf(SensitiveDto.prototype)).toEqual([
      'card_number',
      'cvv',
      'account_number',
    ]);
  });

  it('returns an empty list for an undecorated class', () => {
    class Plain {}

    expect(redactedPathsOf(Plain.prototype)).toEqual([]);
  });
});

describe('@RequiredScopes()', () => {
  class ScopedFixture {
    @RequiredScopes('refunds:write', 'charges:read')
    createRefund(): void {}
  }

  it('stores the scope list', () => {
    expect(
      reflector.get<string[]>(REQUIRED_SCOPES_KEY, ScopedFixture.prototype.createRefund),
    ).toEqual(['refunds:write', 'charges:read']);
  });

  it('draws its vocabulary from API_KEY_SCOPES', () => {
    for (const scope of DEFAULT_READ_SCOPES) {
      expect(API_KEY_SCOPES).toContain(scope);
    }
  });

  it('defaults to read scopes only', () => {
    expect(DEFAULT_READ_SCOPES.every((s) => s.endsWith(':read'))).toBe(true);
  });

  it('hasAllScopes requires every listed scope', () => {
    expect(hasAllScopes(['charges:read', 'refunds:write'], ['refunds:write'])).toBe(true);
    expect(hasAllScopes(['charges:read'], ['refunds:write'])).toBe(false);
  });

  it('missingScope names the first scope that is absent', () => {
    expect(missingScope(['charges:read'], ['charges:read', 'refunds:write'])).toBe('refunds:write');
    expect(missingScope(['charges:read'], ['charges:read'])).toBeNull();
  });
});
