-- 001_init.sql — core schema.
--
-- UNITS (see docs/PROJECT_CONTEXT.md):
--   *_cents  INTEGER  money in KES cents         (KES 58.40 -> 5840)
--   *_g      INTEGER  weight in grams            (620.5 kg  -> 620500)
--   *_bp     INTEGER  percentage in basis points (41.20%    -> 4120)
-- No column in this file ever holds a float for money or weight.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- people
CREATE TABLE app_user (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN
                  ('owner','ops_manager','field_officer','clerk','finance')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- geography
CREATE TABLE location (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('store','ward','catchment')),
  parent_id INTEGER REFERENCES location(id)
);

-- ---------------------------------------------------------------- season
CREATE TABLE season (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  starts_on   TEXT NOT NULL,
  ends_on     TEXT NOT NULL,
  target_g    INTEGER NOT NULL CHECK (target_g >= 0),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

-- ---------------------------------------------------------------- pricing
-- Immutable and versioned. Changing a price INSERTs a new version; the triggers
-- below reject UPDATE and DELETE outright.
CREATE TABLE price_schedule (
  id                       INTEGER PRIMARY KEY,
  season_id                INTEGER NOT NULL REFERENCES season(id),
  version                  INTEGER NOT NULL,
  effective_from           TEXT NOT NULL,
  base_price_cents         INTEGER NOT NULL CHECK (base_price_cents >= 0),
  oil_premium_cents        INTEGER NOT NULL CHECK (oil_premium_cents >= 0),
  moisture_discount_cents  INTEGER NOT NULL CHECK (moisture_discount_cents >= 0),
  damage_discount_cents    INTEGER NOT NULL CHECK (damage_discount_cents >= 0),
  cess_bp                  INTEGER NOT NULL DEFAULT 50 CHECK (cess_bp >= 0),
  recovery_share_bp        INTEGER NOT NULL DEFAULT 5000
                             CHECK (recovery_share_bp BETWEEN 0 AND 10000),
  cash_floor_cents         INTEGER NOT NULL DEFAULT 200000
                             CHECK (cash_floor_cents >= 0),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, version)
);

CREATE TRIGGER price_schedule_no_update BEFORE UPDATE ON price_schedule
BEGIN SELECT RAISE(ABORT, 'price_schedule is immutable: insert a new version'); END;

CREATE TRIGGER price_schedule_no_delete BEFORE DELETE ON price_schedule
BEGIN SELECT RAISE(ABORT, 'price_schedule is immutable: rows cannot be deleted'); END;

-- ---------------------------------------------------------------- farmers
CREATE TABLE farmer (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,          -- FRM-0001
  full_name      TEXT NOT NULL,                 -- name as printed on national ID
  national_id    TEXT NOT NULL UNIQUE,
  phone          TEXT NOT NULL,
  mm_name        TEXT NOT NULL,                 -- name registered on mobile money
  ward_id        INTEGER NOT NULL REFERENCES location(id),
  status         TEXT NOT NULL DEFAULT 'Active'
                   CHECK (status IN ('Active','Inactive')),
  notes          TEXT NOT NULL DEFAULT '',
  registered_on  TEXT NOT NULL,
  registered_at  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX farmer_ward_idx ON farmer(ward_id);

CREATE TABLE parcel (
  id         INTEGER PRIMARY KEY,
  farmer_id  INTEGER NOT NULL REFERENCES farmer(id),
  code       TEXT NOT NULL UNIQUE,              -- PCL-0001
  acreage_bp INTEGER NOT NULL CHECK (acreage_bp > 0),  -- acres x 10000
  gps_lat    TEXT,
  gps_lng    TEXT,
  notes      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX parcel_farmer_idx ON parcel(farmer_id);

-- ---------------------------------------------------------------- contracts
CREATE TABLE contract (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,       -- CTR-0001
  farmer_id         INTEGER NOT NULL REFERENCES farmer(id),
  parcel_id         INTEGER NOT NULL REFERENCES parcel(id),
  season_id         INTEGER NOT NULL REFERENCES season(id),
  expected_g        INTEGER NOT NULL CHECK (expected_g > 0),
  seed_entitlement_g INTEGER NOT NULL CHECK (seed_entitlement_g >= 0),
  recovery_share_bp INTEGER NOT NULL DEFAULT 5000
                      CHECK (recovery_share_bp BETWEEN 0 AND 10000),
  status            TEXT NOT NULL DEFAULT 'Offered'
                      CHECK (status IN ('Offered','Signed','Cancelled')),
  offered_on        TEXT NOT NULL,
  signed_on         TEXT,
  signed_at         TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX contract_farmer_idx ON contract(farmer_id);

-- A contract may only be marked Signed together with a signing date.
CREATE TRIGGER contract_signed_needs_date BEFORE UPDATE ON contract
WHEN NEW.status = 'Signed' AND (NEW.signed_on IS NULL OR NEW.signed_on = '')
BEGIN SELECT RAISE(ABORT, 'a Signed contract must carry signed_on'); END;

-- ---------------------------------------------------------------- inventory
CREATE TABLE item (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('seed','grain','input')),
  unit      TEXT NOT NULL DEFAULT 'g'
);

-- Seed batches. KEPHIS is the Kenya Plant Health Inspectorate Service; certified
-- seed carries a tag number, a germination rate, and a retest due date.
CREATE TABLE lot (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,       -- LOT-0001
  item_id           INTEGER NOT NULL REFERENCES item(id),
  kephis_tag        TEXT NOT NULL UNIQUE,
  germination_bp    INTEGER NOT NULL CHECK (germination_bp BETWEEN 0 AND 10000),
  retest_due_on     TEXT NOT NULL,
  unit_cost_cents   INTEGER NOT NULL CHECK (unit_cost_cents >= 0), -- cents per kg
  received_on       TEXT NOT NULL,
  notes             TEXT NOT NULL DEFAULT ''
);

-- Append-only. Stock on hand is ALWAYS SUM(qty_g) over this table, never a
-- stored column. qty_g is signed: positive receipt, negative issue.
CREATE TABLE stock_movement (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES item(id),
  lot_id        INTEGER REFERENCES lot(id),
  location_id   INTEGER NOT NULL REFERENCES location(id),
  qty_g         INTEGER NOT NULL CHECK (qty_g <> 0),
  reason        TEXT NOT NULL CHECK (reason IN
                  ('receipt','issue','delivery_in','adjustment','dispatch')),
  ref_table     TEXT,
  ref_id        INTEGER,
  notes         TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES app_user(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX stock_movement_bal_idx ON stock_movement(item_id, lot_id, location_id);

CREATE TRIGGER stock_movement_no_update BEFORE UPDATE ON stock_movement
BEGIN SELECT RAISE(ABORT, 'stock_movement is append-only: UPDATE rejected'); END;

CREATE TRIGGER stock_movement_no_delete BEFORE DELETE ON stock_movement
BEGIN SELECT RAISE(ABORT, 'stock_movement is append-only: DELETE rejected'); END;

-- Stock can never go negative. A movement that would overdraw is rejected,
-- not clamped and not corrected afterwards.
CREATE TRIGGER stock_movement_no_negative BEFORE INSERT ON stock_movement
WHEN NEW.qty_g < 0 AND (
  SELECT COALESCE(SUM(qty_g), 0) FROM stock_movement
   WHERE item_id = NEW.item_id
     AND location_id = NEW.location_id
     AND lot_id IS NEW.lot_id
) + NEW.qty_g < 0
BEGIN SELECT RAISE(ABORT, 'stock would go negative: movement rejected'); END;

-- ---------------------------------------------------------------- input credit
CREATE TABLE input_issue (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,         -- ISS-0001
  contract_id     INTEGER NOT NULL REFERENCES contract(id),
  farmer_id       INTEGER NOT NULL REFERENCES farmer(id),
  lot_id          INTEGER NOT NULL REFERENCES lot(id),
  qty_g           INTEGER NOT NULL CHECK (qty_g > 0),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  value_cents     INTEGER NOT NULL CHECK (value_cents >= 0),
  issued_on       TEXT NOT NULL,
  issued_at       TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES app_user(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX input_issue_farmer_idx ON input_issue(farmer_id);

-- Seed cannot be issued against a contract that is not signed. Enforced here in
-- the database as well as in the repository layer.
CREATE TRIGGER input_issue_needs_signed_contract BEFORE INSERT ON input_issue
WHEN (SELECT status FROM contract WHERE id = NEW.contract_id) <> 'Signed'
BEGIN SELECT RAISE(ABORT, 'cannot issue inputs against an unsigned contract'); END;

-- Seed may not be issued from a lot that is overdue for germination retest.
-- The comparison is against the issue date recorded on the row itself.
CREATE TRIGGER input_issue_blocks_overdue_lot BEFORE INSERT ON input_issue
WHEN (SELECT retest_due_on FROM lot WHERE id = NEW.lot_id) < NEW.issued_on
BEGIN SELECT RAISE(ABORT, 'lot is overdue for germination retest'); END;

-- Append-only farmer credit ledger. A farmer's balance is ALWAYS
-- SUM(amount_cents) over this table. Positive = farmer owes us (debit),
-- negative = debt reduced (credit).
CREATE TABLE ledger_entry (
  id           INTEGER PRIMARY KEY,
  farmer_id    INTEGER NOT NULL REFERENCES farmer(id),
  season_id    INTEGER NOT NULL REFERENCES season(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('input_credit','recovery','writeoff','adjustment')),
  ref_table    TEXT,
  ref_id       INTEGER,
  notes        TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES app_user(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ledger_entry_farmer_idx ON ledger_entry(farmer_id, season_id);

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger_entry is append-only: UPDATE rejected'); END;

CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
BEGIN SELECT RAISE(ABORT, 'ledger_entry is append-only: DELETE rejected'); END;

-- ---------------------------------------------------------------- deliveries
-- net_g is GENERATED. It is never typed in and never written to.
CREATE TABLE delivery (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,            -- GRN-00001
  farmer_id    INTEGER NOT NULL REFERENCES farmer(id),
  contract_id  INTEGER NOT NULL REFERENCES contract(id),
  season_id    INTEGER NOT NULL REFERENCES season(id),
  location_id  INTEGER NOT NULL REFERENCES location(id),
  gross_g      INTEGER NOT NULL CHECK (gross_g > 0),
  tare_g       INTEGER NOT NULL DEFAULT 0 CHECK (tare_g >= 0),
  net_g        INTEGER GENERATED ALWAYS AS (gross_g - tare_g) VIRTUAL,
  delivered_on TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  vehicle_reg  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'Pending'
                 CHECK (status IN ('Pending','Graded','Settled','Rejected')),
  notes        TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES app_user(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tare_g < gross_g)
);
CREATE INDEX delivery_farmer_idx ON delivery(farmer_id);
CREATE INDEX delivery_season_idx ON delivery(season_id);

CREATE TABLE quality_test (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,           -- QT-00001
  delivery_id   INTEGER NOT NULL UNIQUE REFERENCES delivery(id),
  moisture_bp   INTEGER NOT NULL CHECK (moisture_bp BETWEEN 0 AND 10000),
  oil_bp        INTEGER NOT NULL CHECK (oil_bp BETWEEN 0 AND 10000),
  foreign_bp    INTEGER NOT NULL CHECK (foreign_bp BETWEEN 0 AND 10000),
  damage_bp     INTEGER NOT NULL CHECK (damage_bp BETWEEN 0 AND 10000),
  grade         TEXT NOT NULL CHECK (grade IN ('A','B','C','REJECT')),
  tested_on     TEXT NOT NULL,
  tested_at     TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES app_user(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- settlement
CREATE TABLE settlement (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,      -- STL-00001
  delivery_id        INTEGER NOT NULL UNIQUE REFERENCES delivery(id),
  farmer_id          INTEGER NOT NULL REFERENCES farmer(id),
  season_id          INTEGER NOT NULL REFERENCES season(id),
  price_schedule_id  INTEGER NOT NULL REFERENCES price_schedule(id),
  payable_g          INTEGER NOT NULL CHECK (payable_g >= 0),
  unit_price_cents   INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  gross_value_cents  INTEGER NOT NULL CHECK (gross_value_cents >= 0),
  cess_cents         INTEGER NOT NULL CHECK (cess_cents >= 0),
  recovery_cents     INTEGER NOT NULL CHECK (recovery_cents >= 0),
  recovery_cap       TEXT NOT NULL CHECK (recovery_cap IN
                       ('share','owed','cash_floor','none')),
  net_payable_cents  INTEGER NOT NULL CHECK (net_payable_cents >= 0),
  amount_paid_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  balance_cents      INTEGER NOT NULL CHECK (balance_cents >= 0),
  status             TEXT NOT NULL DEFAULT 'Pending'
                       CHECK (status IN ('Pending','Approved','Paid','Rejected')),
  computed_on        TEXT NOT NULL,
  computed_at        TEXT NOT NULL,
  approved_by        INTEGER REFERENCES app_user(id),
  approved_at        TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  created_by         INTEGER REFERENCES app_user(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX settlement_farmer_idx ON settlement(farmer_id);
CREATE INDEX settlement_status_idx ON settlement(status);

-- A settlement cannot exist for a delivery that has no quality test.
CREATE TRIGGER settlement_needs_quality_test BEFORE INSERT ON settlement
WHEN NOT EXISTS (SELECT 1 FROM quality_test WHERE delivery_id = NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'cannot settle a delivery with no quality test'); END;

-- The person who decides the grade must never be the person who releases the
-- money. Application code checks the role; this checks the individual.
CREATE TRIGGER settlement_grader_cannot_approve BEFORE UPDATE ON settlement
WHEN NEW.approved_by IS NOT NULL
 AND NEW.approved_by = (SELECT created_by FROM quality_test
                         WHERE delivery_id = NEW.delivery_id)
BEGIN SELECT RAISE(ABORT, 'the grader of a delivery may not approve its settlement'); END;

-- ---------------------------------------------------------------- payments
CREATE TABLE payment (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,       -- PMT-00001
  settlement_id     INTEGER NOT NULL REFERENCES settlement(id),
  farmer_id         INTEGER NOT NULL REFERENCES farmer(id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  method            TEXT NOT NULL DEFAULT 'M-Pesa',
  provider_ref      TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending','Paid','Failed')),
  paid_on           TEXT,
  paid_at           TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Transactional outbox. The instruction row is written in the SAME transaction
-- as the settlement status change; a separate worker drains it.
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY,
  topic           TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  available_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT
);
CREATE INDEX outbox_drain_idx ON outbox(status, available_at);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES app_user(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE rejected'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE rejected'); END;

-- ---------------------------------------------------------------- cloud sync
-- Watermark per table for the optional Supabase mirror. Local SQLite stays the
-- system of record; this only records how far the push has got.
CREATE TABLE sync_state (
  table_name   TEXT PRIMARY KEY,
  last_id      INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  last_error   TEXT
);
