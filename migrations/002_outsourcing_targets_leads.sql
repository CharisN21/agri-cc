-- 002_outsourcing_targets_leads.sql
--
-- v2 scope:
--   * per-ward tonnage targets set by the owner, visible to the ward's officer
--   * ground-referral leads (contractors to call)
--   * outsourcing: non-contracted suppliers bought on grouped SUPPLY RUNS,
--     graded on the same criteria, with the run's real costs captured so
--     landed cost per tonne is a true figure rather than just the grain price
--
-- Same unit rules as 001: money in integer cents, weight in integer grams,
-- percentages in integer basis points.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- targets
-- A user may belong to a ward. Field officers see their own ward's target;
-- owner, ops and finance see the company total. NULL means "not ward-scoped".
ALTER TABLE app_user ADD COLUMN ward_id INTEGER REFERENCES location(id);

-- The owner's target for one ward in one season. season.target_g remains the
-- company-wide number; these are the per-ward breakdown.
CREATE TABLE ward_target (
  id         INTEGER PRIMARY KEY,
  season_id  INTEGER NOT NULL REFERENCES season(id),
  ward_id    INTEGER NOT NULL REFERENCES location(id),
  target_g   INTEGER NOT NULL CHECK (target_g >= 0),
  set_by     INTEGER REFERENCES app_user(id),
  set_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, ward_id)
);

-- ---------------------------------------------------------------- leads
-- Ground referrals: people to call about supplying us. Deliberately mutable —
-- a lead is a working note, not a financial record.
CREATE TABLE lead (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,        -- LEAD-0001
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL DEFAULT '',
  area              TEXT NOT NULL DEFAULT '',    -- free text: village, market, road
  ward_id           INTEGER REFERENCES location(id),
  can_supply_g      INTEGER NOT NULL DEFAULT 0 CHECK (can_supply_g >= 0),
  source            TEXT NOT NULL DEFAULT '',    -- who referred them
  status            TEXT NOT NULL DEFAULT 'To call'
                      CHECK (status IN ('To call','Called','Interested',
                                        'Not interested','Converted')),
  follow_up_on      TEXT,
  last_contacted_on TEXT,
  converted_farmer_id   INTEGER REFERENCES farmer(id),
  converted_supplier_id INTEGER,                 -- FK added with supplier below
  notes             TEXT NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES app_user(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX lead_status_idx ON lead(status, follow_up_on);

-- ---------------------------------------------------------------- suppliers
-- A non-contracted seller. Deliberately lighter than `farmer`: no national ID
-- requirement, no parcel, no contract, no input credit. They sell us grain and
-- we pay them, and that is the whole relationship.
CREATE TABLE supplier (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,              -- SUP-0001
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  area        TEXT NOT NULL DEFAULT '',
  ward_id     INTEGER REFERENCES location(id),
  national_id TEXT,
  mm_name     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES app_user(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------- spot price list
-- Spot buying has its OWN versioned schedule, so the owner can pay outsourced
-- grain a different base price than contracted grain and move the two
-- independently. Immutable, exactly like price_schedule.
CREATE TABLE spot_price_schedule (
  id                      INTEGER PRIMARY KEY,
  season_id               INTEGER NOT NULL REFERENCES season(id),
  version                 INTEGER NOT NULL,
  effective_from          TEXT NOT NULL,
  base_price_cents        INTEGER NOT NULL CHECK (base_price_cents >= 0),
  oil_premium_cents       INTEGER NOT NULL CHECK (oil_premium_cents >= 0),
  moisture_discount_cents INTEGER NOT NULL CHECK (moisture_discount_cents >= 0),
  damage_discount_cents   INTEGER NOT NULL CHECK (damage_discount_cents >= 0),
  cess_bp                 INTEGER NOT NULL DEFAULT 50 CHECK (cess_bp >= 0),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, version)
);

CREATE TRIGGER spot_price_schedule_no_update BEFORE UPDATE ON spot_price_schedule
BEGIN SELECT RAISE(ABORT, 'spot_price_schedule is immutable: insert a new version'); END;

CREATE TRIGGER spot_price_schedule_no_delete BEFORE DELETE ON spot_price_schedule
BEGIN SELECT RAISE(ABORT, 'spot_price_schedule is immutable: rows cannot be deleted'); END;

-- ---------------------------------------------------------------- supply run
-- One buying trip. Costs attach to the RUN, not to a load, because a lorry
-- hire covers everything on board. Landed cost per tonne is only meaningful at
-- this level.
CREATE TABLE supply_run (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,         -- RUN-0001
  season_id        INTEGER NOT NULL REFERENCES season(id),
  location_id      INTEGER NOT NULL REFERENCES location(id),  -- destination store
  field_officer_id INTEGER REFERENCES app_user(id),
  area             TEXT NOT NULL DEFAULT '',     -- where the trip went
  vehicle_reg      TEXT NOT NULL DEFAULT '',
  started_on       TEXT NOT NULL,
  ended_on         TEXT,
  status           TEXT NOT NULL DEFAULT 'Open'
                     CHECK (status IN ('Open','Closed')),
  notes            TEXT NOT NULL DEFAULT '',
  created_by       INTEGER REFERENCES app_user(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX supply_run_season_idx ON supply_run(season_id, status);

-- The real costs of the trip. This is the data that turns "landed cost" from a
-- grain price into a truth.
CREATE TABLE run_cost (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES supply_run(id),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('transport','labour','field_food','housing_allowance',
                  'loading','levy','fuel','other')),
  description  TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  incurred_on  TEXT NOT NULL,
  created_by   INTEGER REFERENCES app_user(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX run_cost_run_idx ON run_cost(run_id);

-- ---------------------------------------------------------- spot purchases
-- A load bought from a non-contracted supplier on a run.
--
-- Two prices are stored on purpose:
--   reference_price_cents — what the spot schedule + grade says it is worth
--   agreed_price_cents    — what the field officer actually negotiated
-- Storing both means a negotiated price stays flexible without becoming
-- unauditable: the variance between them is always visible and always explained.
CREATE TABLE spot_purchase (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,    -- SPT-00001
  run_id                INTEGER NOT NULL REFERENCES supply_run(id),
  supplier_id           INTEGER NOT NULL REFERENCES supplier(id),
  season_id             INTEGER NOT NULL REFERENCES season(id),
  spot_price_schedule_id INTEGER NOT NULL REFERENCES spot_price_schedule(id),
  gross_g               INTEGER NOT NULL CHECK (gross_g > 0),
  tare_g                INTEGER NOT NULL DEFAULT 0 CHECK (tare_g >= 0),
  net_g                 INTEGER GENERATED ALWAYS AS (gross_g - tare_g) VIRTUAL,
  payable_g             INTEGER NOT NULL CHECK (payable_g >= 0),
  reference_price_cents INTEGER NOT NULL CHECK (reference_price_cents >= 0),
  agreed_price_cents    INTEGER NOT NULL CHECK (agreed_price_cents >= 0),
  price_basis           TEXT NOT NULL DEFAULT 'schedule'
                          CHECK (price_basis IN ('schedule','negotiated')),
  price_reason          TEXT NOT NULL DEFAULT '',
  gross_value_cents     INTEGER NOT NULL CHECK (gross_value_cents >= 0),
  cess_cents            INTEGER NOT NULL CHECK (cess_cents >= 0),
  net_payable_cents     INTEGER NOT NULL CHECK (net_payable_cents >= 0),
  amount_paid_cents     INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  balance_cents         INTEGER NOT NULL CHECK (balance_cents >= 0),
  status                TEXT NOT NULL DEFAULT 'Unpaid'
                          CHECK (status IN ('Unpaid','Paid','Rejected')),
  purchased_on          TEXT NOT NULL,
  purchased_at          TEXT NOT NULL,
  method                TEXT NOT NULL DEFAULT 'M-Pesa',
  reference             TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  created_by            INTEGER REFERENCES app_user(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tare_g < gross_g)
);
CREATE INDEX spot_purchase_run_idx ON spot_purchase(run_id);
CREATE INDEX spot_purchase_season_idx ON spot_purchase(season_id);

-- A negotiated price must say why. An unexplained override is the thing that
-- makes a price list meaningless six months later.
CREATE TRIGGER spot_purchase_negotiated_needs_reason BEFORE INSERT ON spot_purchase
WHEN NEW.price_basis = 'negotiated' AND TRIM(NEW.price_reason) = ''
BEGIN SELECT RAISE(ABORT, 'a negotiated price must record why it differs from the schedule'); END;

-- Nothing may be bought onto a run that has been closed off.
CREATE TRIGGER spot_purchase_run_must_be_open BEFORE INSERT ON spot_purchase
WHEN (SELECT status FROM supply_run WHERE id = NEW.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot add a purchase to a closed supply run'); END;

-- ------------------------------------------------- grading, for both paths
-- quality_test is rebuilt so ONE grading table serves contracted deliveries and
-- spot purchases alike — "the same grading criteria", literally, rather than a
-- second copy of the rules that can drift.
--
-- Two triggers on `settlement` read quality_test by name, and SQLite validates
-- them when the table is dropped. They come off first and go back on unchanged
-- at the end of this file — the invariants they enforce are not being relaxed,
-- only stepped around while the table underneath them is swapped.
DROP TRIGGER settlement_needs_quality_test;
DROP TRIGGER settlement_grader_cannot_approve;

CREATE TABLE quality_test_new (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  delivery_id      INTEGER UNIQUE REFERENCES delivery(id),
  spot_purchase_id INTEGER UNIQUE REFERENCES spot_purchase(id),
  moisture_bp      INTEGER NOT NULL CHECK (moisture_bp BETWEEN 0 AND 10000),
  oil_bp           INTEGER NOT NULL CHECK (oil_bp BETWEEN 0 AND 10000),
  foreign_bp       INTEGER NOT NULL CHECK (foreign_bp BETWEEN 0 AND 10000),
  damage_bp        INTEGER NOT NULL CHECK (damage_bp BETWEEN 0 AND 10000),
  grade            TEXT NOT NULL CHECK (grade IN ('A','B','C','REJECT')),
  tested_on        TEXT NOT NULL,
  tested_at        TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  created_by       INTEGER REFERENCES app_user(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- exactly one subject, never both and never neither
  CHECK ((delivery_id IS NULL) <> (spot_purchase_id IS NULL))
);

INSERT INTO quality_test_new
  (id, code, delivery_id, spot_purchase_id, moisture_bp, oil_bp, foreign_bp,
   damage_bp, grade, tested_on, tested_at, notes, created_by, created_at)
SELECT id, code, delivery_id, NULL, moisture_bp, oil_bp, foreign_bp,
       damage_bp, grade, tested_on, tested_at, notes, created_by, created_at
  FROM quality_test;

DROP TABLE quality_test;
ALTER TABLE quality_test_new RENAME TO quality_test;

-- Both settlement invariants restored, byte for byte as they were in 001.
CREATE TRIGGER settlement_needs_quality_test BEFORE INSERT ON settlement
WHEN NOT EXISTS (SELECT 1 FROM quality_test WHERE delivery_id = NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'cannot settle a delivery with no quality test'); END;

CREATE TRIGGER settlement_grader_cannot_approve BEFORE UPDATE ON settlement
WHEN NEW.approved_by IS NOT NULL
 AND NEW.approved_by = (SELECT created_by FROM quality_test
                         WHERE delivery_id = NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'the grader of a delivery may not approve its settlement'); END;

-- ---------------------------------------------------------------- seeding aid
-- Preset seeding rates for the cost calculator. Grams of seed per acre, so the
-- calculator's assumptions are data the owner can change, not a constant
-- buried in code.
CREATE TABLE seeding_rate (
  id           INTEGER PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE,
  g_per_acre   INTEGER NOT NULL CHECK (g_per_acre > 0),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  notes        TEXT NOT NULL DEFAULT ''
);

INSERT INTO seeding_rate (label, g_per_acre, is_default, notes) VALUES
  ('Light  (3 kg/acre)', 3000, 0, 'Wide spacing, good soils'),
  ('Standard (4 kg/acre)', 4000, 1, 'The rate used on most contracts'),
  ('Heavy  (5 kg/acre)', 5000, 0, 'Poorer germination or broadcast sowing');
