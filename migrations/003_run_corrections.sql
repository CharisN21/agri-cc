-- 003_run_corrections.sql
--
-- A supply run is a DRAFT until it is closed.
--
-- The first cut let you add to a run but never correct it: a cost typed as
-- 45,000 instead of 4,500 was permanent, a load booked against the wrong
-- supplier was permanent, and the area you typed at the roadside could never be
-- fixed. That is wrong for a document that is still being written, and it
-- pushed people into leaving runs open or opening duplicates.
--
-- So: while a run is Open, its header, its costs and its loads can all be
-- corrected. The moment it is Closed, all three are frozen — by the triggers
-- below, not by the absence of a button.
--
-- A load is never deleted, because buying one moved grain into the store and
-- possibly money to a supplier. It is VOIDED: the row stays, a reversing stock
-- movement is written, and every total ignores it.

ALTER TABLE spot_purchase ADD COLUMN voided_at   TEXT;
ALTER TABLE spot_purchase ADD COLUMN voided_by   INTEGER REFERENCES app_user(id);
ALTER TABLE spot_purchase ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX spot_purchase_live_idx ON spot_purchase(run_id, voided_at);

-- --- a closed run is finished -------------------------------------------

CREATE TRIGGER supply_run_closed_is_frozen BEFORE UPDATE ON supply_run
WHEN OLD.status = 'Closed' AND NEW.status = 'Closed'
 AND (NEW.area <> OLD.area OR NEW.vehicle_reg <> OLD.vehicle_reg
      OR NEW.started_on <> OLD.started_on OR NEW.notes <> OLD.notes)
BEGIN SELECT RAISE(ABORT, 'this run is closed: reopen it before editing'); END;

CREATE TRIGGER run_cost_run_must_be_open BEFORE INSERT ON run_cost
WHEN (SELECT status FROM supply_run WHERE id = NEW.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot add a cost to a run that is not open'); END;

CREATE TRIGGER run_cost_no_edit_when_closed BEFORE UPDATE ON run_cost
WHEN (SELECT status FROM supply_run WHERE id = OLD.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot change a cost on a closed run'); END;

CREATE TRIGGER run_cost_no_delete_when_closed BEFORE DELETE ON run_cost
WHEN (SELECT status FROM supply_run WHERE id = OLD.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot remove a cost from a closed run'); END;

-- A load may only be voided while its run is still open, and voiding is
-- one-way: a voided load is never quietly un-voided.
CREATE TRIGGER spot_purchase_void_needs_open_run BEFORE UPDATE ON spot_purchase
WHEN NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
 AND (SELECT status FROM supply_run WHERE id = OLD.run_id) <> 'Open'
BEGIN SELECT RAISE(ABORT, 'cannot void a load on a closed run'); END;

CREATE TRIGGER spot_purchase_void_needs_reason BEFORE UPDATE ON spot_purchase
WHEN NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
 AND TRIM(COALESCE(NEW.void_reason, '')) = ''
BEGIN SELECT RAISE(ABORT, 'voiding a load must record a reason'); END;

CREATE TRIGGER spot_purchase_void_is_final BEFORE UPDATE ON spot_purchase
WHEN OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL
BEGIN SELECT RAISE(ABORT, 'a voided load cannot be un-voided; buy it again'); END;

-- A voided load must never still be counted as paid.
CREATE TRIGGER spot_purchase_void_clears_payment BEFORE UPDATE ON spot_purchase
WHEN NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL AND NEW.amount_paid_cents <> 0
BEGIN SELECT RAISE(ABORT, 'reverse the payment before voiding this load'); END;
