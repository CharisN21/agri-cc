// Payment provider interface plus a simulated implementation.
//
// The worker knows only about `send`. Swapping the simulator for a real M-Pesa
// Daraja B2C client means writing one more class with the same method and
// changing the line in getProvider() — no business logic moves.
import crypto from 'node:crypto';

/**
 * @typedef {object} PaymentRequest
 * @property {string} idempotencyKey  stable key; the provider must not double-pay on retry
 * @property {string} phone           msisdn, e.g. 254712345678
 * @property {string} name            payee name as registered on mobile money
 * @property {number} amountCents     integer cents
 * @property {string} reference       our document code, shown on the farmer's statement
 *
 * @typedef {object} PaymentResult
 * @property {boolean} ok
 * @property {string}  [providerRef]  provider's transaction code, e.g. an M-Pesa receipt
 * @property {string}  [message]
 */

export class PaymentProvider {
  /** @param {PaymentRequest} req @returns {Promise<PaymentResult>} */
  // eslint-disable-next-line no-unused-vars
  async send(req) { throw new Error('not implemented'); }
}

/**
 * Simulated provider. Deterministic: the same idempotency key always yields the
 * same reference, so seeded data and tests are reproducible.
 */
export class SimulatedProvider extends PaymentProvider {
  constructor({ failKeys = new Set() } = {}) {
    super();
    this.failKeys = failKeys;
    this.calls = [];
  }

  async send(req) {
    this.calls.push(req);
    if (this.failKeys.has(req.idempotencyKey)) {
      return { ok: false, message: 'simulated provider failure' };
    }
    const digest = crypto.createHash('sha256').update(req.idempotencyKey).digest('hex');
    const ref = `SIM${digest.slice(0, 8).toUpperCase()}`;
    return { ok: true, providerRef: ref, message: 'accepted by simulator' };
  }
}

/**
 * A real implementation would look like this. Left unimplemented on purpose —
 * it exists to prove the seam is the right shape, not to pretend it works.
 *
 * class DarajaB2CProvider extends PaymentProvider {
 *   constructor({ consumerKey, consumerSecret, shortCode, initiatorName, ... }) {...}
 *   async send({ idempotencyKey, phone, amountCents, reference }) {
 *     // POST /mpesa/b2c/v3/paymentrequest with OriginatorConversationID =
 *     // idempotencyKey, Amount = amountCents / 100, PartyB = phone.
 *   }
 * }
 */

let provider = null;
export function getProvider() {
  if (!provider) provider = new SimulatedProvider();
  return provider;
}
export function setProvider(p) { provider = p; }
