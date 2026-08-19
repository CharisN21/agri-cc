// Outbox worker. Drains payment instructions written by approveSettlement().
//
// Exactly-once payout rests on ONE thing: payment.idempotency_key is UNIQUE and
// the insert uses ON CONFLICT DO NOTHING. Draining the same row twice inserts
// one payment row, not two, even if the provider is called twice.
import { getDb, tx } from '../db.js';
import { nextCode, audit } from '../repo.js';
import { getProvider } from './provider.js';
import { isMain } from '../is-main.js';

/**
 * Drain up to `limit` pending outbox rows.
 * @returns {Promise<{claimed:number, paid:number, duplicate:number, failed:number}>}
 */
export async function drainOutbox({ limit = 50, now = new Date() } = {}) {
  const db = getDb();
  const stamp = now.toISOString();
  const today = stamp.slice(0, 10);
  const result = { claimed: 0, paid: 0, duplicate: 0, failed: 0 };

  const pending = db.prepare(
    `SELECT * FROM outbox
      WHERE status = 'pending' AND available_at <= datetime('now')
      ORDER BY id LIMIT ?`,
  ).all(limit);

  for (const row of pending) {
    // Claim the row. The WHERE guard means a second worker cannot claim it too.
    const claimed = db.prepare(
      "UPDATE outbox SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
    ).run(row.id);
    if (claimed.changes === 0) continue;
    result.claimed += 1;

    const payload = JSON.parse(row.payload_json);
    let outcome;
    try {
      const farmer = db.prepare('SELECT * FROM farmer WHERE id = ?').get(payload.farmerId);
      outcome = await getProvider().send({
        idempotencyKey: row.idempotency_key,
        phone: farmer.phone,
        name: farmer.mm_name,
        amountCents: payload.amountCents,
        reference: payload.settlementCode,
      });
    } catch (err) {
      outcome = { ok: false, message: err.message };
    }

    if (!outcome.ok) {
      db.prepare(
        `UPDATE outbox SET status = 'pending', last_error = ?,
                available_at = datetime('now', '+1 minute') WHERE id = ?`,
      ).run(outcome.message ?? 'unknown error', row.id);
      result.failed += 1;
      continue;
    }

    // Record the payment and close out the settlement, atomically.
    tx((d) => {
      const info = d.prepare(
        `INSERT INTO payment (code, settlement_id, farmer_id, amount_cents, method,
                              provider_ref, idempotency_key, status, paid_on, paid_at, notes)
         VALUES (?, ?, ?, ?, 'M-Pesa', ?, ?, 'Paid', ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(nextCode('payment'), payload.settlementId, payload.farmerId,
            payload.amountCents, outcome.providerRef, row.idempotency_key,
            today, stamp, outcome.message ?? '');

      if (info.changes === 0) {
        // Already paid on an earlier drain. Not an error — the whole point.
        result.duplicate += 1;
      } else {
        d.prepare(
          `UPDATE settlement
              SET status = 'Paid', amount_paid_cents = ?, balance_cents = 0
            WHERE id = ?`,
        ).run(payload.amountCents, payload.settlementId);
        audit(null, 'payment.sent', 'settlement', payload.settlementId,
              { providerRef: outcome.providerRef, amountCents: payload.amountCents });
        result.paid += 1;
      }

      d.prepare(
        "UPDATE outbox SET status = 'done', processed_at = ?, last_error = NULL WHERE id = ?",
      ).run(stamp, row.id);
    });
  }

  return result;
}

// Run directly: `npm run worker` drains once, `--loop` keeps draining.
if (isMain(import.meta.url)) {
  const loop = process.argv.includes('--loop');
  const once = async () => {
    const r = await drainOutbox();
    if (r.claimed) {
      console.log(`outbox: claimed ${r.claimed}, paid ${r.paid}, duplicate ${r.duplicate}, failed ${r.failed}`);
    }
  };
  await once();
  if (loop) {
    console.log('outbox worker running; ctrl-c to stop');
    setInterval(() => { once().catch((e) => console.error(e.message)); }, 5000);
  }
}
