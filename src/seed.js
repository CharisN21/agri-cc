// Deterministic seed data.
//
// No Math.random() anywhere: a seeded PRNG and a fixed reference date, so every
// business value is reproducible. Two runs produce identical farmers, contracts,
// weights, grades, prices, settlements and ledger entries — verified by hashing
// those tables across clean runs.
//
// The exception, deliberately: `created_at` columns default to datetime('now')
// and so differ between runs. Those are audit stamps recording when the row was
// really written; freezing them would be a lie. The business dates the app
// reasons about (registered_on, delivered_on, issued_on, …) are all derived from
// SEED_TODAY below and are stable.
//
// This matters because the dashboard numbers are the ones you will read to judge
// whether the app is telling the truth.
import { getDb, tx } from './db.js';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import * as repo from './repo.js';
import { drainOutbox } from './payments/worker.js';

const SEED_TODAY = '2026-08-18';   // fixed "now" for the whole seed run
const SEASON_START = '2026-03-01';

/** mulberry32 — small, fast, and reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260818);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const at = (iso, h, m) => `${iso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

const FIRST = ['Peter', 'Grace', 'Samuel', 'Mary', 'Joseph', 'Esther', 'Daniel', 'Ruth',
  'John', 'Alice', 'David', 'Faith', 'James', 'Nancy', 'Paul', 'Lucy',
  'Simon', 'Jane', 'Moses', 'Rose', 'Isaac', 'Sarah', 'Elijah', 'Naomi'];
const LAST = ['Kariuki', 'Wanjiru', 'Otieno', 'Achieng', 'Mutua', 'Nduta', 'Kiplagat',
  'Chebet', 'Mwangi', 'Njeri', 'Omondi', 'Atieno', 'Kamau', 'Wambui',
  'Barasa', 'Nasimiyu', 'Korir', 'Jepkosgei', 'Musyoka', 'Mwikali',
  'Ochieng', 'Adhiambo', 'Rotich', 'Chepkoech'];

/** The accounts created by seed(). Kept separate so applySeedPassword() can
 *  target exactly these and never touch a real user added later. */
export const DEMO_USERNAMES = ['owner', 'ops', 'field1', 'field2', 'clerk', 'finance'];

/**
 * Force the demo accounts onto the current SEED_PASSWORD.
 *
 * seed() only runs against an empty database, so on a host where the database
 * file survives a restart, changing SEED_PASSWORD would otherwise have no
 * effect at all and the old password would silently keep working. This runs on
 * every boot, is idempotent, and makes the environment variable authoritative.
 * With SEED_PASSWORD unset it does nothing, so local development keeps the
 * documented defaults.
 */
export function applySeedPassword({ log = console.log } = {}) {
  if (!config.seedPassword) return 0;
  const db = getDb();
  const update = db.prepare(
    'UPDATE app_user SET password_hash = ?, password_salt = ? WHERE username = ?',
  );
  let changed = 0;
  for (const username of DEMO_USERNAMES) {
    const { hash, salt } = hashPassword(config.seedPassword);
    changed += update.run(hash, salt, username).changes;
  }
  if (changed) log(`  demo accounts set to SEED_PASSWORD (${changed} account(s))`);
  return changed;
}

export function seed({ log = console.log } = {}) {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) AS n FROM farmer').get().n > 0) {
    log('  database already has data; run `npm run reset` first');
    return;
  }

  tx(() => {
    // --- users ------------------------------------------------------------
    const users = [
      ['owner', 'Wanjiku Mburu', 'owner'],
      ['ops', 'Kevin Ochieng', 'ops_manager'],
      ['field1', 'Agnes Cherono', 'field_officer'],
      ['field2', 'Brian Mutiso', 'field_officer'],
      ['clerk', 'Dorothy Anyango', 'clerk'],
      ['finance', 'Hassan Abdille', 'finance'],
    ];
    const userIds = {};
    for (const [username, fullName, role] of users) {
      // SEED_PASSWORD lets a public demo deployment use something other than
      // the passwords printed in the README.
      const { hash, salt } = hashPassword(config.seedPassword || `${username}123`);
      const info = db.prepare(
        `INSERT INTO app_user (username, full_name, role, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(username, fullName, role, hash, salt);
      userIds[username] = info.lastInsertRowid;
    }

    // --- geography --------------------------------------------------------
    const storeId = db.prepare(
      "INSERT INTO location (code, name, kind) VALUES ('STR-01', 'Nakuru Central Store', 'store')",
    ).run().lastInsertRowid;
    const wardNames = [
      ['WRD-01', 'Rongai'],
      ['WRD-02', 'Njoro'],
      ['WRD-03', 'Subukia'],   // this is the ward that will under-deliver
    ];
    const wardIds = wardNames.map(([code, name]) =>
      db.prepare("INSERT INTO location (code, name, kind) VALUES (?, ?, 'ward')")
        .run(code, name).lastInsertRowid);

    // --- season and prices -----------------------------------------------
    const seasonId = db.prepare(
      `INSERT INTO season (code, name, starts_on, ends_on, target_g)
       VALUES ('S2026', 'Long rains 2026', ?, ?, ?)`,
    ).run(SEASON_START, '2026-11-30', 30_000_000).lastInsertRowid; // 30 tonnes

    // v1 opened the season; v2 is the price actually in force. Two versions
    // exist so "which version did this settlement use" is a real question.
    db.prepare(
      `INSERT INTO price_schedule
         (season_id, version, effective_from, base_price_cents, oil_premium_cents,
          moisture_discount_cents, damage_discount_cents, cess_bp,
          recovery_share_bp, cash_floor_cents)
       VALUES (?, 1, ?, 5600, 150, 200, 120, 50, 5000, 200000)`,
    ).run(seasonId, SEASON_START);
    db.prepare(
      `INSERT INTO price_schedule
         (season_id, version, effective_from, base_price_cents, oil_premium_cents,
          moisture_discount_cents, damage_discount_cents, cess_bp,
          recovery_share_bp, cash_floor_cents)
       VALUES (?, 2, ?, 5800, 150, 200, 120, 50, 5000, 200000)`,
    ).run(seasonId, '2026-06-01');

    // --- items and seed lots ---------------------------------------------
    const seedItemId = db.prepare(
      "INSERT INTO item (code, name, kind) VALUES ('SEED-SF', 'Certified sunflower seed', 'seed')",
    ).run().lastInsertRowid;
    db.prepare(
      "INSERT INTO item (code, name, kind) VALUES ('GRN-SF', 'Sunflower grain', 'grain')",
    ).run();

    const lots = [
      ['LOT-0001', 'KEPHIS/2026/SF/0413', 9200, addDays(SEED_TODAY, 45), 32000, '2026-02-20'],
      ['LOT-0002', 'KEPHIS/2026/SF/0517', 8850, addDays(SEED_TODAY, 12), 31500, '2026-02-28'],
      // Deliberately overdue: the issue screen must refuse to release from it.
      ['LOT-0003', 'KEPHIS/2025/SF/0902', 8100, addDays(SEED_TODAY, -20), 29800, '2025-12-11'],
    ];
    const lotIds = lots.map(([code, tag, germ, retest, cost, received]) => {
      const id = db.prepare(
        `INSERT INTO lot (code, item_id, kephis_tag, germination_bp, retest_due_on,
                          unit_cost_cents, received_on, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(code, seedItemId, tag, germ, retest, cost, received,
            retest < SEED_TODAY ? 'Overdue for germination retest' : '').lastInsertRowid;
      // Receive the lot into the store.
      db.prepare(
        `INSERT INTO stock_movement (item_id, lot_id, location_id, qty_g, reason, notes, created_by)
         VALUES (?, ?, ?, ?, 'receipt', 'Opening receipt', ?)`,
      ).run(seedItemId, id, storeId, 400_000, userIds.ops);
      return id;
    });

    // --- farmers, parcels, contracts -------------------------------------
    const farmers = [];
    for (let i = 0; i < 24; i += 1) {
      const wardIdx = i % 3;
      const fullName = `${FIRST[i]} ${LAST[i]}`;
      // One farmer's mobile-money name does not match their ID name. This is a
      // real and common problem: the payout will bounce or land on a relative.
      const mmName = i === 7 ? `${FIRST[i]} ${LAST[(i + 5) % LAST.length]}` : fullName;
      const registeredOn = addDays(SEASON_START, between(0, 25));
      const { id: farmerId, code } = repo.createFarmer({
        full_name: fullName,
        national_id: String(21000000 + i * 1373),
        phone: `2547${String(10000000 + i * 314159).slice(0, 8)}`,
        mm_name: mmName,
        ward_id: wardIds[wardIdx],
        notes: i === 7 ? 'Mobile money registered in spouse name — confirm before payout' : '',
        registered_on: registeredOn,
        registered_at: at(registeredOn, 9, between(0, 59)),
      }, userIds.field1);

      const acreageBp = between(7500, 40000); // 0.75 to 4.00 acres
      const { id: parcelId } = repo.createParcel({
        farmer_id: farmerId,
        acreage_bp: acreageBp,
        notes: pick(['Near the river', 'Roadside plot', 'Behind the homestead', 'Leased plot']),
      }, userIds.field1);

      // Expect roughly 700 kg per acre.
      const expectedG = Math.round((acreageBp / 10000) * 700_000);
      const offeredOn = addDays(registeredOn, between(2, 10));
      const { id: contractId } = repo.offerContract({
        farmer_id: farmerId,
        parcel_id: parcelId,
        season_id: seasonId,
        expected_g: expectedG,
        seed_entitlement_g: Math.round((acreageBp / 10000) * 4000), // 4 kg per acre
        recovery_share_bp: 5000,
        offered_on: offeredOn,
        notes: '',
      }, userIds.ops);

      // Two farmers never sign — so the "unsigned contract" path has real data.
      const signs = i !== 11 && i !== 19;
      if (signs) {
        const signedOn = addDays(offeredOn, between(1, 8));
        repo.signContract(contractId, { signedOn, signedAt: at(signedOn, 11, between(0, 59)) },
                          userIds.ops);
      }
      farmers.push({ farmerId, contractId, code, fullName, wardIdx, expectedG, signs, acreageBp });
    }

    // --- seed issues ------------------------------------------------------
    for (const f of farmers) {
      if (!f.signs) continue;
      const qtyG = Math.round((f.acreageBp / 10000) * 4000);
      const issuedOn = addDays(SEASON_START, between(12, 30));
      repo.issueInputs({
        contractId: f.contractId,
        lotId: rand() < 0.55 ? lotIds[0] : lotIds[1],   // never the overdue lot
        qtyG,
        issuedOn,
        issuedAt: at(issuedOn, 10, between(0, 59)),
        notes: pick(['Collected at store', 'Delivered by field officer', 'Group collection']),
      }, userIds.field1);
    }

    // --- deliveries, grading, settlement ---------------------------------
    // Ward index 2 (Subukia) under-delivers badly: its farmers bring in a
    // fraction of what their acreage should have produced. That is what the
    // side-selling watchlist is for, and it needs something true to show.
    const graders = [userIds.field1, userIds.field2, userIds.clerk];
    let settlementsMade = 0;

    for (const f of farmers) {
      if (!f.signs) continue;
      const underDelivering = f.wardIdx === 2;
      const loads = underDelivering ? between(0, 1) : between(1, 3);

      for (let n = 0; n < loads; n += 1) {
        const shareBp = underDelivering ? between(1200, 2600) : between(3000, 6500);
        const netG = Math.max(40_000, Math.round((f.expectedG * shareBp) / 10000 / (loads || 1)));
        const tareG = between(8_000, 22_000);
        const grossG = netG + tareG;
        const deliveredOn = addDays('2026-07-05', between(0, 40));

        const { id: deliveryId } = repo.createDelivery({
          farmerId: f.farmerId,
          contractId: f.contractId,
          grossG, tareG,
          deliveredOn,
          deliveredAt: at(deliveredOn, between(8, 16), between(0, 59)),
          vehicleReg: `K${pick(['AA', 'BQ', 'CT', 'DM'])} ${between(100, 999)}${pick(['A', 'B', 'C'])}`,
          notes: pick(['Own transport', 'Group lorry', 'Office pickup', 'Collected at ward centre']),
        }, userIds.clerk);

        // Quality: mostly buyable, with a few wet and one or two rejects.
        const roll = rand();
        let moistureBp; let oilBp; let foreignBp; let damageBp;
        if (roll < 0.06) {                       // too wet to buy
          moistureBp = between(1420, 1650); oilBp = between(3900, 4300);
          foreignBp = between(150, 600); damageBp = between(300, 700);
        } else if (roll < 0.20) {                // wet enough to worry about
          moistureBp = between(1210, 1390); oilBp = between(3750, 4250);
          foreignBp = between(200, 750); damageBp = between(300, 900);
        } else if (roll < 0.55) {                // solid grade A material
          moistureBp = between(700, 1000); oilBp = between(4100, 4600);
          foreignBp = between(50, 350); damageBp = between(100, 480);
        } else {                                  // ordinary B and C
          moistureBp = between(900, 1200); oilBp = between(3600, 4150);
          foreignBp = between(150, 900); damageBp = between(200, 800);
        }

        const grader = graders[(f.farmerId + n) % graders.length];
        const { grade } = repo.gradeDelivery({
          deliveryId, moistureBp, oilBp, foreignBp, damageBp,
          testedOn: deliveredOn,
          testedAt: at(deliveredOn, between(9, 17), between(0, 59)),
          notes: '',
        }, grader);
        if (grade === 'REJECT') continue;

        // Settle most graded loads; leave a few sitting so the dashboard's
        // "awaiting approval" alert is not empty.
        if (rand() < 0.85) {
          const { id: settlementId } = repo.createSettlement(deliveryId, {
            computedOn: deliveredOn,
            computedAt: at(deliveredOn, between(10, 18), between(0, 59)),
          }, userIds.clerk);
          settlementsMade += 1;

          // Approve about three quarters of them. The approver is never the
          // grader — finance and the owner sign off, field staff do not.
          if (rand() < 0.75) {
            const approver = rand() < 0.7
              ? { id: userIds.finance } : { id: userIds.owner };
            repo.approveSettlement(settlementId, {
              approvedAt: at(addDays(deliveredOn, 1), between(9, 16), between(0, 59)),
            }, approver);
          }
        }
      }
    }

    log(`  seeded ${farmers.length} farmers, ${settlementsMade} settlements`);
  });

  return { drainSome: true };
}

/** Pay most of the queued payouts, leaving a few unpaid on purpose. */
export async function seedPayments({ log = console.log } = {}) {
  const db = getDb();
  const queued = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get().n;
  // Hold back the last few so "Approved but unpaid" has something to show.
  const toDrain = Math.max(0, queued - 3);
  if (toDrain === 0) return;
  const r = await drainOutbox({ limit: toDrain });
  log(`  paid ${r.paid} settlement(s); ${queued - toDrain} left queued on purpose`);
}
