-- 005_offers_and_budget.sql
--
-- Three things a supply run was missing.
--
-- 1. OFFERS. A field officer arrives in an area and finds several farms willing
--    to sell at different prices and different quantities. He needs to compare
--    them before committing. The comparison is not "who is cheapest per kg",
--    because the cost of the trip is FIXED: hiring the lorry costs the same
--    whether it comes back with 300kg or 3 tonnes. So a farm asking more per
--    kilogram can be the cheaper buy, simply by filling the vehicle. The offer
--    table exists so that judgement can be made on screen instead of in
--    someone's head at the roadside.
--
-- 2. A BUDGET. Costs were only ever recorded after the fact, so there was no
--    such thing as "over budget" — only a bill. A run now carries projected
--    firm costs set when it opens, and the actual costs are compared against
--    them.
--
-- 3. SUPPLEMENTARY COSTS AND SAVINGS. The road was worse than expected and the
--    lorry cost more: the officer asks the owner to approve the difference. Or
--    he did it cheaper than projected: he declares the saving, and it becomes a
--    pot the next trip can draw on. Both are requests the owner decides, and
--    both are recorded either way, so "we always go over" stops being an
--    argument and becomes a number.

-- --- a run now has a tonnage target and a projected cost --------------------
ALTER TABLE supply_run ADD COLUMN target_g INTEGER NOT NULL DEFAULT 0;

-- A projected cost line is the budget; an actual line is what was spent.
ALTER TABLE run_cost ADD COLUMN is_projected INTEGER NOT NULL DEFAULT 0
  CHECK (is_projected IN (0, 1));

CREATE INDEX run_cost_kind_idx ON run_cost(run_id, is_projected);

-- --- offers ----------------------------------------------------------------
CREATE TABLE run_offer (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,          -- OFR-00001
  run_id            INTEGER NOT NULL REFERENCES supply_run(id),
  supplier_id       INTEGER NOT NULL REFERENCES supplier(id),
  offered_g         INTEGER NOT NULL CHECK (offered_g > 0),
  asking_price_cents INTEGER NOT NULL CHECK (asking_price_cents >= 0),
  -- What the officer expects the grain to grade, so the comparison is not made
  -- on price alone. Estimates, not measurements: the real test happens at the
  -- weighbridge and can disagree.
  est_moisture_bp   INTEGER CHECK (est_moisture_bp BETWEEN 0 AND 10000),
  est_oil_bp        INTEGER CHECK (est_oil_bp BETWEEN 0 AND 10000),
  status            TEXT NOT NULL DEFAULT 'Open'
                      CHECK (status IN ('Open', 'Accepted', 'Declined', 'Expired')),
  decline_reason    TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  offered_on        TEXT NOT NULL,
  created_by        INTEGER REFERENCES app_user(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX run_offer_run_idx ON run_offer(run_id, status);

-- Offers belong to an open run, like everything else on it.
CREATE TRIGGER run_offer_needs_open_run BEFORE INSERT ON run_offer
WHEN (SELECT status FROM supply_run WHERE id = NEW.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot add an offer to a run that is not open'); END;

CREATE TRIGGER run_offer_no_change_when_closed BEFORE UPDATE ON run_offer
WHEN (SELECT status FROM supply_run WHERE id = OLD.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot change an offer on a closed run'); END;

-- Declining an offer must say why, so a pattern of always declining the same
-- farm is visible rather than folklore.
CREATE TRIGGER run_offer_decline_needs_reason BEFORE UPDATE ON run_offer
WHEN NEW.status = 'Declined' AND TRIM(COALESCE(NEW.decline_reason, '')) = ''
BEGIN SELECT RAISE(ABORT, 'say why this offer was declined'); END;

-- --- supplementary costs and declared savings ------------------------------
CREATE TABLE run_cost_request (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,             -- REQ-00001
  run_id         INTEGER NOT NULL REFERENCES supply_run(id),
  -- 'supplementary' asks for more than was projected.
  -- 'saving' gives back what was not needed.
  direction      TEXT NOT NULL CHECK (direction IN ('supplementary', 'saving')),
  kind           TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Requested'
                   CHECK (status IN ('Requested', 'Approved', 'Declined')),
  requested_by   INTEGER REFERENCES app_user(id),
  requested_on   TEXT NOT NULL,
  decided_by     INTEGER REFERENCES app_user(id),
  decided_at     TEXT,
  decision_note  TEXT NOT NULL DEFAULT '',
  -- Set when an approved supplementary is paid for out of savings declared on
  -- earlier trips rather than out of new money.
  from_savings   INTEGER NOT NULL DEFAULT 0 CHECK (from_savings IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX run_cost_request_idx ON run_cost_request(run_id, status);

-- A request must say why. This is the whole point of asking.
CREATE TRIGGER run_cost_request_needs_reason BEFORE INSERT ON run_cost_request
WHEN TRIM(COALESCE(NEW.reason, '')) = ''
BEGIN SELECT RAISE(ABORT, 'a cost request must say why'); END;

-- The person who asked for the money may not be the person who grants it.
-- Same rule as grading and settlement: whoever wants it does not approve it.
CREATE TRIGGER run_cost_request_asker_cannot_decide BEFORE UPDATE ON run_cost_request
WHEN NEW.decided_by IS NOT NULL AND NEW.decided_by = OLD.requested_by
BEGIN SELECT RAISE(ABORT, 'you cannot approve your own cost request'); END;

-- A decision is final. Changing your mind means a new request.
CREATE TRIGGER run_cost_request_decision_is_final BEFORE UPDATE ON run_cost_request
WHEN OLD.status <> 'Requested' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'this request has already been decided'); END;
