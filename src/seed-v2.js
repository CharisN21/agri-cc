// Seed data for the v2 features: ward targets, referral leads, and outsourcing.
//
// Same discipline as seed.js — a seeded PRNG and a fixed reference date, so two
// runs produce the same numbers. Kept in its own file so the original seed stays
// readable.
//
// The supply runs below are deliberately different from each other: one is a
// good trip, one is ruined by its transport bill. If every run looked the same
// the landed-cost screen would prove nothing.
import { getDb, tx } from './db.js';
import * as admin from './repo-admin.js';
import * as out from './repo-outsourcing.js';
import * as plan from './repo-offers.js';

const TODAY = '2026-08-18';

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(778899);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const at = (iso, h, m) => `${iso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

export function seedV2({ log = console.log } = {}) {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) AS n FROM supplier').get().n > 0) return;

  const season = db.prepare("SELECT * FROM season WHERE status = 'open' ORDER BY starts_on DESC").get();
  if (!season) return;
  const wards = db.prepare("SELECT * FROM location WHERE kind = 'ward' ORDER BY id").all();
  const users = Object.fromEntries(
    db.prepare('SELECT id, username FROM app_user').all().map((u) => [u.username, u.id]));

  tx(() => {
    // --- field officers belong to a ward, so they see their own target -----
    db.prepare('UPDATE app_user SET ward_id = ? WHERE username = ?').run(wards[0].id, 'field1');
    db.prepare('UPDATE app_user SET ward_id = ? WHERE username = ?').run(wards[2].id, 'field2');

    // --- the owner's targets ----------------------------------------------
    // They add up to slightly less than the company target on purpose: the
    // "unallocated" figure on the targets screen should have something to show.
    const wardTargets = [11_000_000, 9_000_000, 8_000_000]; // 11t, 9t, 8t vs 30t company
    wards.forEach((w, i) => admin.setWardTarget(season.id, w.id, wardTargets[i], users.owner));

    // --- spot price schedule ----------------------------------------------
    // Well below the contracted base of KES 58.00. Spot suppliers carry no seed
    // advance and no contract, so the grain is bought cheaper — which is the
    // whole reason outsourcing can be worth the transport.
    out.addSpotScheduleVersion(season.id, {
      effective_from: '2026-06-15',
      base_price_cents: 5200,
      oil_premium_cents: 150,
      moisture_discount_cents: 200,
      damage_discount_cents: 120,
      cess_bp: 50,
    }, users.owner);

    // --- referral leads ----------------------------------------------------
    const leads = [
      ['Wycliffe Barasa', '254711000101', 'Bahati market', 0, 3_000_000, 'Interested', '2026-08-22',
       'Has 4 acres, wants to know our price before committing'],
      ['Mercy Wanjala', '254711000102', 'Solai centre', 1, 1_800_000, 'Called', '2026-08-25',
       'Asked us to call after harvest'],
      ['Kipkoech Traders', '254711000103', 'Subukia town', 2, 12_000_000, 'Interested', '2026-08-20',
       'Aggregator, buys from about 20 smallholders. Worth a visit.'],
      ['Anne Njoki', '254711000104', 'Kabatini', 0, 900_000, 'To call', '2026-08-21', ''],
      ['Samuel Kiprop', '254711000105', 'Mbogoini', 1, 2_400_000, 'To call', '2026-08-19',
       'Referred by FRM-0004'],
      ['Grace Wairimu', '254711000106', 'Lanet', 0, 600_000, 'Not interested', null,
       'Already contracted to another buyer this season'],
      ['Dennis Okumu', '254711000107', 'Rongai centre', 0, 4_500_000, 'Interested', '2026-08-26',
       'Wants transport included in the price'],
    ];
    for (const [name, phone, area, wardIdx, canG, status, followUp, note] of leads) {
      const { id } = admin.createLead({
        name, phone, area, ward_id: wards[wardIdx].id, can_supply_g: canG,
        source: 'Field officer referral', follow_up_on: followUp,
        notes: note ? `[2026-08-12] ${note}` : '',
      }, users.field1);
      if (status !== 'To call') {
        admin.logLeadContact(id, {
          status, notes: '', followUpOn: followUp, contactedOn: '2026-08-14',
        }, users.field1);
      }
    }

    // --- suppliers ---------------------------------------------------------
    const supplierNames = [
      ['Wilson Kimani', 'Subukia town', 2], ['Beatrice Wangari', 'Solai centre', 1],
      ['Patrick Ouma', 'Bahati market', 0], ['Salome Chelangat', 'Subukia town', 2],
      ['Zakayo Mwaura', 'Kabatini', 0], ['Hellen Nyambura', 'Mbogoini', 1],
    ];
    const supplierIds = supplierNames.map(([name, area, wardIdx]) => out.createSupplier({
      name, phone: `2547220001${between(10, 99)}`, area,
      ward_id: wards[wardIdx].id, mm_name: name, notes: '',
    }, users.field2).id);

    // --- supply runs -------------------------------------------------------
    // Run 1: close by, cheap transport, good grain. Should beat contracted.
    // Run 2: far out, expensive lorry, small tonnage. Should lose money.
    // Run 3: still open, so the screens have a live one to work with.
    const runs = [
      {
        area: 'Bahati and Kabatini', started: '2026-07-18', vehicle: 'KBQ 447C',
        costs: [['transport', 'Pickup hire, one day', 450_000],
                ['labour', 'Two loaders', 120_000],
                ['field_food', 'Officer meals', 40_000]],
        loads: [[812_000, 18_000, 900, 4050, 250, 350, null],
                [744_000, 16_500, 1020, 3980, 400, 480, null],
                [910_000, 20_000, 880, 4100, 180, 300, null]],
        close: '2026-07-19',
      },
      {
        area: 'Subukia far side', started: '2026-07-29', vehicle: 'KCT 902A',
        costs: [['transport', 'Lorry hire, poor road', 1_450_000],
                ['fuel', 'Diesel', 380_000],
                ['labour', 'Loading gang', 200_000],
                ['field_food', 'Officer meals, two days', 90_000],
                ['housing_allowance', 'Officer overnight', 250_000]],
        loads: [[318_000, 8_000, 1180, 3900, 620, 700, 5300],
                [274_000, 7_500, 1250, 3820, 700, 810, 5200]],
        close: '2026-07-31',
      },
      {
        area: 'Solai centre', started: '2026-08-15', vehicle: 'KDM 118B',
        costs: [['transport', 'Pickup hire', 400_000],
                ['labour', 'Loaders', 90_000]],
        loads: [[520_000, 12_000, 950, 4200, 300, 400, null],
                [430_000, 10_000, 1450, 4000, 350, 450, null], // this one rejects: 14.50% moisture
                [468_000, 11_500, 1050, 4090, 280, 520, 5700]],
        close: null,
      },
    ];

    let bought = 0; let rejected = 0;
    runs.forEach((spec, ri) => {
      const { id: runId } = out.createRun({
        season_id: season.id, area: spec.area, vehicle_reg: spec.vehicle,
        started_on: spec.started, notes: '',
      }, users.field2);

      spec.loads.forEach(([grossG, tareG, moist, oil, fm, dmg, agreed], li) => {
        const r = out.createSpotPurchase({
          runId,
          supplierId: supplierIds[(ri * 2 + li) % supplierIds.length],
          grossG, tareG,
          moistureBp: moist, oilBp: oil, foreignBp: fm, damageBp: dmg,
          agreedPriceCents: agreed,
          priceReason: agreed
            ? 'Farmer had another buyer at the gate; agreed above the schedule to secure the load'
            : '',
          purchasedOn: spec.started,
          purchasedAt: at(spec.started, between(9, 16), between(0, 59)),
          method: 'M-Pesa',
          reference: `SPT${between(100000, 999999)}`,
          notes: '',
        }, users.field2);
        if (r.rejected) rejected += 1; else bought += 1;
        // Most are paid on the spot; a couple are left owing.
        if (!r.rejected && rand() < 0.8) {
          out.markSpotPaid(r.id, { reference: `QK${between(10000000, 99999999)}`, paidOn: spec.started },
                           users.finance);
        }
      });

      for (const [kind, description, amount] of spec.costs) {
        out.addRunCost({
          run_id: runId, kind, description, amount_cents: amount, incurred_on: spec.started,
        }, users.field2);
      }

      // The open run carries a target, a budget, and offers still to decide.
      // They are chosen so the cheapest price per kilogram is NOT the best buy:
      // that is the whole point of the comparison screen.
      if (!spec.close) {
        plan.setRunTarget(runId, 2_500_000, users.owner);
        for (const [kind, description, amount] of [
          ['transport', 'Projected pickup hire', 400_000],
          ['labour', 'Projected loaders', 90_000],
        ]) {
          out.addRunCost({ run_id: runId, kind, description, amount_cents: amount,
                           incurred_on: spec.started, is_projected: 1 }, users.owner);
        }
        const offers = [
          [0, 300_000, 5000],    // cheapest per kg, but a small load
          [1, 2_000_000, 5400],  // dearest per kg, but fills the vehicle
          [3, 900_000, 5200],
        ];
        for (const [si, offeredG, price] of offers) {
          plan.addOffer({
            run_id: runId, supplier_id: supplierIds[si], offered_g: offeredG,
            asking_price_cents: price, offered_on: spec.started,
            notes: '', est_moisture_bp: null, est_oil_bp: null,
          }, users.field2);
        }
        // A real overrun on the road, waiting on the owner.
        plan.requestCostChange({
          run_id: runId, direction: 'supplementary', kind: 'transport',
          amount_cents: 180_000,
          reason: 'Road washed out past Solai; had to hire a second vehicle for the last stretch',
          requested_on: spec.started,
        }, users.field2);
      }

      if (spec.close) out.closeRun(runId, { endedOn: spec.close }, users.ops);
    });

    // A saving declared on the first trip and approved: the pot other trips draw on.
    const firstRun = db.prepare("SELECT id FROM supply_run WHERE code = 'RUN-0001'").get();
    if (firstRun) {
      const sv = plan.requestCostChange({
        run_id: firstRun.id, direction: 'saving', kind: 'transport',
        amount_cents: 120_000,
        reason: 'Shared the pickup with a neighbouring trader, hire came in under budget',
        requested_on: '2026-07-19',
      }, users.field2);
      plan.decideCostRequest(sv.id, {
        status: 'Approved', note: 'Well done', decidedAt: '2026-07-20T09:00:00Z',
      }, { id: users.owner });
    }

    log(`  seeded ${supplierIds.length} suppliers, ${runs.length} supply runs, `
      + `${bought} spot loads (${rejected} rejected), ${leads.length} referrals`);
  });
}

export { TODAY };
