import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';

/**
 * The lifecycle in domain-model.md §2. Written month 2 by `dhotfix` and — per the
 * blueprint's hot/cold split — never touched since, which is the point: a state machine
 * that changes every sprint is not a state machine, it is a pile of ifs.
 */
describe('PaymentIntentStateMachine', () => {
  let fsm: PaymentIntentStateMachine;

  beforeEach(() => {
    fsm = new PaymentIntentStateMachine();
  });

  describe('the happy path', () => {
    it('requires_payment_method → requires_confirmation on attach', () => {
      expect(fsm.apply('requires_payment_method', 'attach_payment_method')).toBe(
        'requires_confirmation',
      );
    });

    it('requires_confirmation → processing on confirm', () => {
      expect(fsm.apply('requires_confirmation', 'confirm')).toBe('processing');
    });

    it('processing → succeeded on authorisation with automatic capture', () => {
      expect(fsm.apply('processing', 'succeed')).toBe('succeeded');
    });

    it('processing → requires_capture on authorisation with manual capture', () => {
      expect(fsm.apply('processing', 'authorize_manual')).toBe('requires_capture');
    });

    it('requires_capture → succeeded on capture', () => {
      expect(fsm.apply('requires_capture', 'capture')).toBe('succeeded');
    });
  });

  describe('confirming with the payment method on the request', () => {
    // Regression: `confirm` was only an edge out of requires_confirmation, so the one-call confirm
    // every client makes (hosted checkout included) was refused from requires_payment_method.
    it('requires_payment_method → processing on confirm', () => {
      expect(fsm.apply('requires_payment_method', 'confirm')).toBe('processing');
    });

    it('a decline sends the intent back for another card, and that card can be confirmed', () => {
      const declined = fsm.apply('processing', 'decline');

      expect(declined).toBe('requires_payment_method');
      expect(fsm.apply(declined, 'confirm')).toBe('processing');
    });
  });

  describe('the SCA branch', () => {
    it('processing → requires_action when the issuer demands a challenge', () => {
      expect(fsm.apply('processing', 'require_action')).toBe('requires_action');
    });

    it('requires_action → processing when the challenge is completed', () => {
      expect(fsm.apply('requires_action', 'confirm')).toBe('processing');
    });

    it('requires_action → failed when the challenge is abandoned', () => {
      expect(fsm.apply('requires_action', 'fail')).toBe('failed');
    });
  });

  describe('failure and cancellation', () => {
    it('processing → failed on a decline', () => {
      expect(fsm.apply('processing', 'fail')).toBe('failed');
    });

    it.each(['requires_payment_method', 'requires_confirmation', 'requires_capture'])(
      'cancels from %s',
      (from) => {
        expect(fsm.apply(from, 'cancel')).toBe('canceled');
      },
    );

    it('refuses to cancel a succeeded intent — that is a refund, not a cancellation', () => {
      expect(fsm.can('succeeded', 'cancel')).toBe(false);
      expect(() => fsm.apply('succeeded', 'cancel')).toThrow(InvalidStateTransitionException);
    });
  });

  describe('illegal transitions', () => {
    it('cannot capture straight from requires_confirmation', () => {
      expect(() => fsm.apply('requires_confirmation', 'capture')).toThrow(
        InvalidStateTransitionException,
      );
    });

    it('cannot confirm an already-succeeded intent', () => {
      expect(fsm.can('succeeded', 'confirm')).toBe(false);
    });

    it('cannot re-enter processing from failed — the merchant creates a new intent', () => {
      expect(fsm.can('failed', 'confirm')).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('treats succeeded, failed and canceled as terminal', () => {
      expect([...fsm.terminalStates].sort()).toEqual(['canceled', 'failed', 'succeeded']);
    });

    it.each(['succeeded', 'failed', 'canceled'])('assertNotTerminal throws for %s', (state) => {
      expect(() => fsm.assertNotTerminal(state as never)).toThrow(
        InvalidStateTransitionException,
      );
    });

    it('assertNotTerminal passes for processing', () => {
      expect(() => fsm.assertNotTerminal('processing')).not.toThrow();
    });
  });
});
